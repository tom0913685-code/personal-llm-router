import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adminGet, adminPost, adminPatch, backendUrl, McpRestError } from './rest-client.js';

// @article topic:mcp-server
// 工具清單跟每個工具對應的 REST endpoint，完全依照
// docs/requirements/07-mcp-server.md「功能需求：工具清單」——查詢類 6 個、
// 管理類 5 個，明確不開放 api_keys 相關工具（見同份文件 2026-09-23 段落）。

interface Deployment {
  id: string;
  credentialId: string;
  publicModelName: string;
  enabled: boolean;
  [key: string]: unknown;
}

interface Credential {
  id: string;
  enabled: boolean;
  [key: string]: unknown;
}

const CREDENTIAL_ADAPTER_TYPES = ['passthrough', 'anthropic_native'] as const;

// get_integration_guide 靜態部分也拿來當 McpServer 的 instructions——
// agent 一連上線就看得到用途說明，不用等它主動呼叫這個工具（07-mcp-server.md
// 已定案的要求）。認證格式依 08-api-key-layer.md：Bearer 一把使用者自己在
// Web UI「API Keys」頁面申請的 key，不是固定的 ROUTER_API_KEY。
export const INTEGRATION_GUIDE_STATIC_TEXT = [
  '個人版 LLM Router：把多個 LLM provider（OpenAI 相容 API、Anthropic 原生 API 等）',
  '統一包成同一組 OpenAI 相容的 /v1/chat/completions 介面，並提供 Deployment 優先序',
  '跟自動 Fallback（主要 deployment 失敗時自動改打次要的），讓呼叫端只認得一個',
  '穩定的 public model 名稱，不用關心背後實際是哪個 provider 在服務。',
  '',
  '呼叫方式：',
  '  Authorization: Bearer <key>',
  '  （這把 key 由使用者自行在 Web UI 的「API Keys」頁面申請，不是固定的環境變數）',
  '  POST {baseURL}/v1/chat/completions，body 格式跟 OpenAI Chat Completions API 相容，',
  '  body.model 填下面「目前可用的 public model 名稱」其中一個。',
].join('\n');

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof McpRestError ? `${err.message} (HTTP ${err.status})` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function withErrorHandling(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

// @article topic:mcp-server
// code review 2026-09-23 抓到的問題：只濾 deployment.enabled 不夠——
// resolveDeploymentCandidates()（src/routing/resolve.ts）實際判斷一個
// model 打不打得通，要求 deployment 跟它所屬的 credential 都 enabled。
// 這裡不比照那份邏輯的話，停用 Credential 後底下的 model 還是會被列成
// 「可用」，agent 照著打會拿到 404，跟這個工具講的內容矛盾。
export async function getEnabledPublicModelNames(): Promise<string[]> {
  const [deployments, credentials] = await Promise.all([
    adminGet<Deployment[]>('/admin/deployments'),
    adminGet<Credential[]>('/admin/credentials'),
  ]);
  const enabledCredentialIds = new Set(credentials.filter((c) => c.enabled).map((c) => c.id));
  const names = new Set(
    deployments.filter((d) => d.enabled && enabledCredentialIds.has(d.credentialId)).map((d) => d.publicModelName),
  );
  return Array.from(names).sort();
}

export async function getIntegrationGuide(): Promise<{ guide: string; baseURL: string; availableModels: string[] }> {
  const availableModels = await getEnabledPublicModelNames();
  return { guide: INTEGRATION_GUIDE_STATIC_TEXT, baseURL: `${backendUrl()}/v1`, availableModels };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'get_integration_guide',
    {
      title: '取得整合說明',
      description: '回傳這個 service 的用途說明、/v1/chat/completions 的 baseURL／認證方式，以及目前有哪些 public model 名稱可以呼叫。',
    },
    async () => withErrorHandling(() => getIntegrationGuide()),
  );

  server.registerTool(
    'list_models',
    {
      title: '列出可用 model',
      description: '列出目前啟用中的 public model 名稱，決定要打哪個 model 時用這個。',
    },
    async () => withErrorHandling(() => getEnabledPublicModelNames()),
  );

  server.registerTool(
    'list_deployments',
    {
      title: '列出 Deployment',
      description: '完整 Deployment 清單，含 priority、health_status、定價、auto_health_check_enabled。',
    },
    async () => withErrorHandling(() => adminGet('/admin/deployments')),
  );

  server.registerTool(
    'list_credentials',
    {
      title: '列出 Credential',
      description: 'Credential 清單（不含 api_key 明文）。',
    },
    async () => withErrorHandling(() => adminGet('/admin/credentials')),
  );

  server.registerTool(
    'get_usage_summary',
    {
      title: '取得用量彙總',
      description: '花費/請求數/錯誤率/Fallback 觸發率彙總。',
      inputSchema: {
        rangeHours: z.number().positive().optional().describe('只統計過去幾小時內的請求，不填代表全部'),
      },
    },
    async ({ rangeHours }) =>
      withErrorHandling(() => {
        const query = rangeHours !== undefined ? `?rangeHours=${rangeHours}` : '';
        return adminGet(`/admin/logs/summary${query}`);
      }),
  );

  server.registerTool(
    'search_logs',
    {
      title: '查詢請求 log',
      description: '請求明細查詢，可依時間區間/model/deployment/狀態篩選，分頁回傳。',
      inputSchema: {
        rangeHours: z.number().positive().optional(),
        publicModelName: z.string().optional(),
        deploymentId: z.string().optional(),
        status: z.enum(['success', 'error']).optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) =>
      withErrorHandling(() => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (value !== undefined) params.set(key, String(value));
        }
        const query = params.toString();
        return adminGet(`/admin/logs${query ? `?${query}` : ''}`);
      }),
  );

  server.registerTool(
    'create_credential',
    {
      title: '新增 Credential',
      description: '新增一組上游 provider 的連線設定（API base URL + api key）。',
      inputSchema: {
        name: z.string().min(1),
        adapterType: z.enum(CREDENTIAL_ADAPTER_TYPES),
        baseUrl: z.string().min(1).optional().describe('adapterType 為 passthrough 時必填'),
        apiKey: z.string().min(1),
        enabled: z.boolean().optional(),
      },
    },
    async (input) => withErrorHandling(() => adminPost('/admin/credentials', input)),
  );

  server.registerTool(
    'update_credential',
    {
      title: '編輯 Credential',
      description: '編輯既有 Credential（含啟用/停用）。apiKey 留空（不帶這個欄位，或帶空字串）代表不更動。',
      inputSchema: {
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        adapterType: z.enum(CREDENTIAL_ADAPTER_TYPES).optional(),
        baseUrl: z.string().min(1).optional(),
        // 跟 REST 層（credentials.routes.ts）的語意對齊：空字串代表
        // 「不更動」，不能用 min(1) 擋掉，否則傳空字串會被 schema 驗證直接
        // 拒絕，跟後端實際行為不一致。
        apiKey: z.string().optional(),
        enabled: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => withErrorHandling(() => adminPatch(`/admin/credentials/${id}`, body)),
  );

  server.registerTool(
    'create_deployment',
    {
      title: '新增 Deployment',
      description: '把一個 Credential 底下的實際 model 掛成一個 public model 名稱的 Deployment。',
      inputSchema: {
        credentialId: z.string().min(1),
        publicModelName: z.string().min(1),
        providerModelId: z.string().min(1),
        priority: z.number().int().optional(),
        inputCostPerMillion: z.number().min(0).optional(),
        outputCostPerMillion: z.number().min(0).optional(),
        enabled: z.boolean().optional(),
        autoHealthCheckEnabled: z.boolean().optional(),
      },
    },
    async (input) => withErrorHandling(() => adminPost('/admin/deployments', input)),
  );

  server.registerTool(
    'update_deployment',
    {
      title: '編輯 Deployment',
      description: '編輯既有 Deployment（含啟用/停用、調整 priority）。',
      inputSchema: {
        id: z.string().min(1),
        credentialId: z.string().min(1).optional(),
        publicModelName: z.string().min(1).optional(),
        providerModelId: z.string().min(1).optional(),
        priority: z.number().int().optional(),
        inputCostPerMillion: z.number().min(0).optional(),
        outputCostPerMillion: z.number().min(0).optional(),
        enabled: z.boolean().optional(),
        autoHealthCheckEnabled: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => withErrorHandling(() => adminPatch(`/admin/deployments/${id}`, body)),
  );

  server.registerTool(
    'trigger_health_check',
    {
      title: '手動觸發健康檢查',
      description: '對指定 Deployment 立即送一次真的 model 檢查（不是輕量連線檢查）。',
      inputSchema: {
        deploymentId: z.string().min(1),
      },
    },
    async ({ deploymentId }) => withErrorHandling(() => adminPost(`/admin/deployments/${deploymentId}/health-check`, {})),
  );
}
