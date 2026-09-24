export const REQUEST_TIMEOUT_MS = 30_000;

export interface UnifiedChatRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
}

export interface UnifiedChatResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  raw: unknown; // 保留原始回應，供需要存取廠商特有欄位時使用
}

export interface ProviderAdapter {
  chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse>;
  ping(): Promise<{ latencyMs: number }>; // 供健康檢測模組呼叫（手動觸發，非排程）
}
