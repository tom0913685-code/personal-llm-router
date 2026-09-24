import { REQUEST_TIMEOUT_MS, type ProviderAdapter, type UnifiedChatRequest, type UnifiedChatResponse } from './types.js';
import { UpstreamProviderError } from '../errors.js';

export interface PassthroughConfig {
  baseUrl: string;
  apiKey: string;
}

// @article topic:error-message-scrub-bypass
// 上游錯誤回應的 body 若是合法 JSON，回傳解析後的物件（呼叫端會再過
// scrubSensitive() 遮罩敏感欄位才使用）；不是 JSON（純文字/HTML 錯誤頁）
// 的話，沒有安全的方式從自由格式文字裡挑出敏感內容，保守起見整段捨棄，
// 只保留呼叫端已經記錄的 HTTP 狀態碼，避免明文外洩。
async function parseErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class PassthroughAdapter implements ProviderAdapter {
  constructor(private readonly config: PassthroughConfig) {}

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const { baseUrl, apiKey } = this.config;
    const messages = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : req.messages;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new UpstreamProviderError(`Provider error: ${res.status}`, await parseErrorBody(res));
    }

    const data = (await res.json()) as {
      choices?: { message?: { content: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    // @article topic:error-message-scrub-bypass
    // code review 2026-09-23 抓到的問題：這兩個分支原本直接
    // `throw new Error(\`...${JSON.stringify(data)}\`)`，把完整的上游回應
    // 塞進 .message——跟 !res.ok 那支不一樣，完全繞過 UpstreamProviderError
    // 的 .message／.providerDetail 分離設計，chat.routes.ts 會把這個
    // .message 原封不動回給呼叫端、寫進 request_logs，scrubSensitive() 也
    // 救不了（它只比對物件 key 名稱，這裡整包塞在字串裡）。改成跟 !res.ok
    // 一樣丟 UpstreamProviderError：.message 只留安全的泛用描述，原始
    // data 放進 .providerDetail，呼叫端會先過 scrubSensitive() 才使用。
    //
    // 除了「message 存在」還要檢查 content 是不是字串——上游若回的是
    // tool-call 回應（content: null，內容在 tool_calls）或多模態陣列格式，
    // 舊版檢查會誤判成功，把非字串塞進宣告是 string 的欄位。
    if (!message || typeof message.content !== 'string') {
      throw new UpstreamProviderError('Unexpected response shape from provider', data);
    }
    // usage 整個缺失時寧可報錯也不要靜默記 0：cost 算出 $0 但實際不是免費，
    // 是比明確失敗更難察覺、更危險的錯誤資料。usage 存在但個別子欄位缺
    // （某些相容伺服器只回其中一個）才用 ?? 0 兜底。
    if (!data.usage) {
      throw new UpstreamProviderError('Unexpected response shape from provider: missing usage field', data);
    }

    return {
      content: message.content,
      usage: {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
      },
      raw: data,
    };
  }

  async ping(): Promise<{ latencyMs: number }> {
    const { baseUrl, apiKey } = this.config;
    const start = Date.now();

    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new UpstreamProviderError(`Health check failed: ${res.status}`, await parseErrorBody(res));
    return { latencyMs: Date.now() - start };
  }
}
