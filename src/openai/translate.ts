import type { UnifiedChatRequest, UnifiedChatResponse } from '../adapters/types.js';
import { ValidationError } from '../errors.js';

export interface OpenAiChatRequestBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
}

// 02-gateway.md：把 client 傳來的 OpenAI-shape body 轉成 UnifiedChatRequest。
// OpenAI 格式把 system 放在 messages 陣列裡（role: 'system'），但
// UnifiedChatRequest 是獨立的 system 欄位，這裡負責把兩者拆開。
export function toUnifiedChatRequest(body: OpenAiChatRequestBody, providerModelId: string): UnifiedChatRequest {
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new ValidationError('model is required');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ValidationError('messages must be a non-empty array');
  }

  const systemParts: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const raw of body.messages) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as any).content !== 'string') {
      throw new ValidationError('each message must have a string content');
    }
    const role = (raw as any).role;
    const content = (raw as any).content as string;
    if (role === 'system') {
      systemParts.push(content);
    } else if (role === 'user' || role === 'assistant') {
      messages.push({ role, content });
    } else {
      throw new ValidationError(`unsupported message role "${role}" (tool/function calling is not supported in this version)`);
    }
  }

  if (messages.length === 0) {
    throw new ValidationError('messages must contain at least one user/assistant message');
  }

  return {
    model: providerModelId,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
  };
}

export function toOpenAiChatResponse(requestId: string, publicModelName: string, result: UnifiedChatResponse) {
  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: publicModelName,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
  };
}

export function toOpenAiErrorBody(message: string, type: string) {
  return { error: { message, type } };
}
