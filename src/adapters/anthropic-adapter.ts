import Anthropic from '@anthropic-ai/sdk';
import { REQUEST_TIMEOUT_MS, type ProviderAdapter, type UnifiedChatRequest, type UnifiedChatResponse } from './types.js';
import { UpstreamProviderError } from '../errors.js';

// @article topic:error-message-scrub-bypass
// Anthropic SDK 的 APIError.message 本身就是「status + 原始 body」拼出來的
// 字串（見 node_modules/@anthropic-ai/sdk/core/error.js 的 makeMessage()），
// 跟 passthrough-adapter 修掉的 #3 是同一個洩漏風險。這裡攔截後改丟我們
// 自己的 UpstreamProviderError：.message 只留安全的泛用文字，結構化的
// err.error（未遮罩）放進 .providerDetail 讓呼叫端自行 scrub 後使用。
function toUpstreamError(err: unknown, fallbackLabel: string): never {
  if (err instanceof Anthropic.APIError) {
    throw new UpstreamProviderError(`${fallbackLabel}: ${err.status ?? 'unknown'}`, err.error);
  }
  throw err;
}

export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    // maxRetries: 0——SDK 預設 maxRetries=2，逾時/5xx/429 會在背景重試並疊加
    // sleep backoff，讓 `timeout` 變成「每次嘗試」各自的上限而非整體硬上限
    // （可能拖到 90 秒以上才真正失敗）。PassthroughAdapter 用
    // AbortSignal.timeout() 是硬性 30 秒中止，兩個 adapter 應該對
    // REQUEST_TIMEOUT_MS 有一致的保證，尤其 ping() 健康檢查期待快速有界的
    // 結果。Fallback 機制本身已經是我們自己的重試層，不需要 SDK 再疊一層。
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: req.model,
        system: req.system,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
      });
    } catch (err) {
      toUpstreamError(err, 'Provider error');
    }

    const textBlock = res.content.find((b) => b.type === 'text');
    // 回應被 max_tokens 截斷、且還沒產出任何 text block 時，textBlock 會是
    // undefined——跟「模型真的沒話說」無法區分，寧可明確報錯，不要安靜回
    // 空字串讓呼叫端誤以為是正常的空回應。
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error(
        `Unexpected response shape: no text content block (stop_reason=${res.stop_reason ?? 'unknown'})`,
      );
    }

    return {
      content: textBlock.text,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
      raw: res,
    };
  }

  async ping(): Promise<{ latencyMs: number }> {
    // 用 models.list() 而非打一次 chat completion：驗證 API key 有效且可連線，
    // 不綁定特定 model、不燒 token 成本（原草稿用 messages.create 打死 model 名稱，
    // 該 model 若停用或帳號無權限，會誤判 provider 不可用）。
    const start = Date.now();
    try {
      await this.client.models.list({ limit: 1 });
    } catch (err) {
      toUpstreamError(err, 'Health check failed');
    }
    return { latencyMs: Date.now() - start };
  }
}
