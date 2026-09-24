import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { resolveDeploymentCandidates } from '../routing/resolve.js';
import { getAdapter } from '../routing/adapter-cache.js';
import { toUnifiedChatRequest, toOpenAiChatResponse, type OpenAiChatRequestBody } from '../openai/translate.js';
import { recordRequestLog, calculateCost } from '../logs/record.js';
import { scrubSensitive } from '../logs/scrub.js';
import { incrementSpend } from '../billing/budget.js';
import { ValidationError, UpstreamProviderError } from '../errors.js';

export const chatRouter = Router();

chatRouter.post('/chat/completions', async (req, res) => {
  const requestId = randomUUID();
  res.setHeader('x-request-id', requestId);
  const start = Date.now();

  // Content-Type 不是 application/json 時 express.json() 完全不處理 body，
  // req.body 會是 undefined——直接往下取欄位會噴 TypeError，被全域錯誤
  // middleware 當成未預期例外回 500 並洩漏內部錯誤訊息。在這裡先擋掉，轉成
  // 乾淨的 400。
  if (typeof req.body !== 'object' || req.body === null) {
    throw new ValidationError('request body must be valid JSON with Content-Type: application/json');
  }

  const body = req.body as OpenAiChatRequestBody;

  // 02-gateway.md 已定案：stream:true 要明確拒絕，不能默默改用非串流回應。
  if (body.stream === true) {
    throw new ValidationError('streaming not supported in this version');
  }

  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new ValidationError('model is required');
  }

  // 先解析路由：解析失敗（model 沒設定/停用、body 格式不對）視為用戶端請求
  // 錯誤，不寫進 request_logs——沒有 deployment 可以附著的 snapshot 資料。
  // resolveDeploymentCandidates 回傳依 priority 排序的候選清單，長度 >= 1。
  const candidates = resolveDeploymentCandidates(body.model);

  // 用第一筆候選的 provider_model_id 驗證/轉換一次 body（訊息格式驗證跟選
  // 哪個 candidate 無關，只需要做一次），Fallback 時只需要替換 model 欄位。
  const baseUnifiedRequest = toUnifiedChatRequest(body, candidates[0].deployment.providerModelId);

  // @article topic:fallback-routing
  // 依序嘗試每一筆候選；某一筆失敗就換下一筆，直到成功或全部候選都試過。
  // 全部失敗時，回傳給 client 的是「最後一筆」候選的錯誤，不是第一筆的——
  // 最後一筆失敗代表「所有備援都試過了」，這個錯誤對使用者診斷問題最有
  // 參考價值。
  for (let i = 0; i < candidates.length; i++) {
    const { deployment, credential } = candidates[i];
    const attemptNumber = i + 1;
    const fallbackUsed = i > 0;
    const isLastCandidate = i === candidates.length - 1;

    const unifiedRequest = { ...baseUnifiedRequest, model: deployment.providerModelId };
    const adapter = getAdapter(credential.id);

    // 只包住「呼叫上游」這件事——log 寫入的失敗（DB 忙碌/唯讀等）不該被這
    // 個 catch 誤判成「上游服務錯誤」，兩者是完全不同的失敗來源，見下方
    // 分開的 log try/catch。
    let result;
    try {
      result = await adapter.chat(unifiedRequest);
    } catch (err) {
      if (!isLastCandidate) {
        continue; // 換下一筆候選，這筆失敗先不記 log（只有「最終結果」才記一筆）
      }

      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : 'Unknown upstream error';
      // @article topic:error-message-scrub-bypass
      // UpstreamProviderError 的 .message 是刻意不含上游回應內容的安全泛用
      // 文字；.providerDetail 才是結構化、未遮罩的完整錯誤內容，這裡先過
      // scrubSensitive() 才存進 provider_error（見 errors.ts 的說明）。
      const providerDetail = err instanceof UpstreamProviderError ? err.providerDetail : { message };

      // @article topic:fallback-routing
      // fallbackUsed 在這個分支成立，代表不只「這一筆」失敗——前面優先度較
      // 高的候選也都試過、也都失敗了，是整條 Fallback 候補鏈用盡，跟「本來
      // 就只有一筆 deployment、它失敗了」是質性不同的失敗（後者沒有備援可
      // 選，前者是備援也救不回來）。呼叫端拿到的 message 仍然只反映「最後
      // 一筆」的失敗原因（見上方註解），但額外用 code/fallbackExhausted 讓
      // 呼叫端能分辨出「候補已經用盡」這件事，不用自己比對 fallbackAttempts
      // 才能推斷。
      const errorCode = fallbackUsed ? 'all_candidates_failed' : 'upstream_error';

      // log 寫入失敗也不能讓它變成未攔截例外——上游確實失敗了，這個結果
      // 還是要回給 client，log 寫不進去頂多記錄不完整，不能整個請求都沒
      // 回應。
      try {
        recordRequestLog({
          requestId,
          deploymentId: deployment.id,
          apiKeyId: req.apiKey?.id,
          publicModelName: deployment.publicModelName,
          providerModelId: deployment.providerModelId,
          status: 'error',
          statusCode: 502,
          errorCode,
          errorMessage: message,
          providerError: scrubSensitive(providerDetail),
          latencyMs,
          fallbackUsed,
          fallbackAttempts: attemptNumber,
        });
      } catch (logErr) {
        console.error('Failed to record request log (error path):', logErr);
      }

      // 失敗請求 cost 一定是 0（calculateCost() 根本沒被呼叫到），不用另外
      // 呼叫 incrementSpend() 累加 0——那樣只會白白動一次 DB、還讓
      // updated_at 看起來像被改過，但實際上 current_spend 什麼都沒變。
      res.status(502).json({
        error: {
          message,
          type: 'upstream_error',
          ...(fallbackUsed && {
            code: 'all_candidates_failed',
            fallbackExhausted: true,
            attemptedCandidates: attemptNumber,
          }),
        },
      });
      return;
    }

    const latencyMs = Date.now() - start;
    const cost = calculateCost(
      result.usage.inputTokens,
      result.usage.outputTokens,
      deployment.inputCostPerMillion,
      deployment.outputCostPerMillion,
    );

    // 同上：log 寫入失敗不能吞掉已經成功拿到的上游回應，優先把結果回給
    // client，log 失敗只在背景記錄，不影響這次請求的成敗。
    try {
      recordRequestLog({
        requestId,
        deploymentId: deployment.id,
        apiKeyId: req.apiKey?.id,
        publicModelName: deployment.publicModelName,
        providerModelId: deployment.providerModelId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cost,
        status: 'success',
        statusCode: 200,
        latencyMs,
        fallbackUsed,
        fallbackAttempts: attemptNumber,
      });
    } catch (logErr) {
      console.error('Failed to record request log (success path):', logErr);
    }

    // 累加進這把 key 的 current_spend，讓 requireGatewayKey 下次驗證時看
    // 到最新的花費——跟 log 寫入一樣，失敗不能擋掉已經成功的回應。
    try {
      if (req.apiKey) incrementSpend(req.apiKey.id, cost);
    } catch (spendErr) {
      console.error('Failed to increment API key spend:', spendErr);
    }

    res.json(toOpenAiChatResponse(requestId, deployment.publicModelName, result));
    return;
  }
});
