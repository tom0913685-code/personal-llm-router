import { AnthropicAdapter } from './anthropic-adapter.js';
import { PassthroughAdapter } from './passthrough-adapter.js';
import type { ProviderAdapter } from './types.js';

// @article topic:provider-adapter
// 依「跟 OpenAI 格式相容的程度」分流，不是每家 provider 都當作需要客製轉換：
// passthrough（OpenAI/Ollama/vLLM/Gemini）直接透傳，只有協議真的差很大的
// （目前僅 Anthropic）才走 native 轉換型。見 docs/article-notes.md。
export interface ProviderConfig {
  adapterType: 'passthrough' | 'anthropic_native';
  baseUrl?: string;
  apiKey: string;
}

export function createProviderAdapter(config: ProviderConfig): ProviderAdapter {
  switch (config.adapterType) {
    case 'anthropic_native':
      return new AnthropicAdapter(config.apiKey);
    case 'passthrough':
      if (!config.baseUrl) {
        throw new Error('Passthrough adapter requires baseUrl');
      }
      return new PassthroughAdapter({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
    default:
      throw new Error(`Unknown adapter type: ${config.adapterType}`);
  }
}
