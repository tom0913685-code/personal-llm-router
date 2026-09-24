import { createSessionToken, SESSION_COOKIE_NAME } from '../auth/session.js';

// @article topic:mcp-server
// MCP server 是 `/admin/*` REST API 的 thin client，不直接碰 DB——理由見
// docs/requirements/07-mcp-server.md「架構決定」。驗證方式：直接用共用的
// SITE_SESSION_SECRET 自己簽一顆合法的 session token 當 Cookie，不走登入
// 流程換 cookie（同一份文件「驗證」段落，2026-09-23 定案）。

export class McpRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'McpRestError';
  }
}

export function backendUrl(): string {
  return process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
}

function sessionSecret(): string {
  const secret = process.env.SITE_SESSION_SECRET;
  if (!secret) {
    throw new Error('SITE_SESSION_SECRET is not set——MCP server 需要跟後端共用這把金鑰才能簽 session token');
  }
  return secret;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await createSessionToken(sessionSecret());
  const res = await fetch(`${backendUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...init?.headers,
    },
  });

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message ?? `Request to ${path} failed with status ${res.status}`;
    throw new McpRestError(message, res.status);
  }
  return body as T;
}

export function adminGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function adminPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function adminPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
