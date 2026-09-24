import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from './tools.js';

process.env.SITE_SESSION_SECRET = randomBytes(32).toString('hex');

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// @article topic:mcp-server
// 用 InMemoryTransport 把一個真的 McpServer 跟一個真的 Client 接在一起
// （同一個 process 內），實際跑一次 tools/list、tools/call——只 mock 最外
// 層的 fetch（模擬 /admin/* REST API），驗證的是「registerTools() 真的把
// 11 個工具正確接到 REST client」這條完整路徑，不是繞過 SDK 直接測內部
// 函式。
async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: Record<string, unknown>): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

function mockDeploymentsAndCredentials(t: TestContext, deployments: unknown[], credentials: unknown[]): void {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (new URL(url).pathname === '/admin/credentials') return jsonResponse(credentials);
    return jsonResponse(deployments);
  });
}

test('list_models 只回傳 enabled=true 且所屬 credential 也 enabled=true 的 deployment，去重並排序', async (t) => {
  mockDeploymentsAndCredentials(
    t,
    [
      { id: '1', credentialId: 'c1', publicModelName: 'gpt-5.1', enabled: true },
      { id: '2', credentialId: 'c1', publicModelName: 'gpt-5.1', enabled: true },
      { id: '3', credentialId: 'c1', publicModelName: 'claude-x', enabled: false },
      { id: '4', credentialId: 'c1', publicModelName: 'a-model', enabled: true },
    ],
    [{ id: 'c1', enabled: true }],
  );

  const client = await connectedClient();
  const result = await client.callTool({ name: 'list_models', arguments: {} });
  assert.deepEqual(textOf(result), ['a-model', 'gpt-5.1']);
});

// @article topic:mcp-server
// code review 2026-09-23：deployment.enabled=true 不代表 model 真的打得
// 通——所屬 credential 被停用時，resolveDeploymentCandidates() 一樣視同
// 找不到（見 src/routing/resolve.ts），這裡要跟那份邏輯一致，不然 agent
// 會被 list_models 誤導去打一個實際上會 404 的 model。
test('list_models 排除 deployment.enabled=true 但所屬 credential 已停用的 model', async (t) => {
  mockDeploymentsAndCredentials(
    t,
    [{ id: '1', credentialId: 'c1', publicModelName: 'gpt-5.1', enabled: true }],
    [{ id: 'c1', enabled: false }],
  );

  const client = await connectedClient();
  const result = await client.callTool({ name: 'list_models', arguments: {} });
  assert.deepEqual(textOf(result), []);
});

test('get_integration_guide 回傳 baseURL 跟目前可用的 model 清單', async (t) => {
  mockDeploymentsAndCredentials(t, [{ id: '1', credentialId: 'c1', publicModelName: 'gpt-5.1', enabled: true }], [{ id: 'c1', enabled: true }]);

  const client = await connectedClient();
  const result = await client.callTool({ name: 'get_integration_guide', arguments: {} });
  const body = textOf(result) as { guide: string; baseURL: string; availableModels: string[] };
  assert.ok(body.guide.includes('Authorization: Bearer'));
  assert.equal(body.baseURL, 'http://localhost:8787/v1');
  assert.deepEqual(body.availableModels, ['gpt-5.1']);
});

test('search_logs 把工具參數正確組成 query string 打 GET /admin/logs', async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ items: [], total: 0 });
  });

  const client = await connectedClient();
  await client.callTool({
    name: 'search_logs',
    arguments: { rangeHours: 24, publicModelName: 'gpt-5.1', status: 'error', page: 2, pageSize: 20 },
  });

  const url = new URL(capturedUrl!);
  assert.equal(url.pathname, '/admin/logs');
  assert.equal(url.searchParams.get('rangeHours'), '24');
  assert.equal(url.searchParams.get('publicModelName'), 'gpt-5.1');
  assert.equal(url.searchParams.get('status'), 'error');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('pageSize'), '20');
});

test('create_credential 呼叫 POST /admin/credentials，body 帶齊工具參數', async (t) => {
  let capturedUrl: string | undefined;
  let capturedBody: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse({ id: 'new-id' }, { status: 201 });
  });

  const client = await connectedClient();
  const result = await client.callTool({
    name: 'create_credential',
    arguments: { name: 'openai', adapterType: 'passthrough', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
  });

  assert.equal(new URL(capturedUrl!).pathname, '/admin/credentials');
  assert.deepEqual(capturedBody, { name: 'openai', adapterType: 'passthrough', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  assert.deepEqual(textOf(result), { id: 'new-id' });
});

// @article topic:mcp-server
// code review 2026-09-23：REST 層（credentials.routes.ts）把 apiKey 留空
// 當「不更動」，schema 之前用 min(1) 會把這個合法輸入擋在 MCP 這一層，
// 回一個含糊的 zod 錯誤而不是後端原本設計的 no-op 成功。
test('update_credential 的 apiKey 允許空字串（跟 REST 層「留空代表不更動」的語意一致）', async (t) => {
  let capturedBody: unknown;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse({ id: 'cred-1', name: 'openai' });
  });

  const client = await connectedClient();
  const result = await client.callTool({ name: 'update_credential', arguments: { id: 'cred-1', apiKey: '', enabled: false } });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedBody, { apiKey: '', enabled: false });
});

test('update_deployment 把 id 從 path 拿掉，不會混進 PATCH body', async (t) => {
  let capturedUrl: string | undefined;
  let capturedBody: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse({ id: 'dep-1', priority: 1 });
  });

  const client = await connectedClient();
  await client.callTool({ name: 'update_deployment', arguments: { id: 'dep-1', priority: 1 } });

  assert.equal(new URL(capturedUrl!).pathname, '/admin/deployments/dep-1');
  assert.deepEqual(capturedBody, { priority: 1 });
});

test('trigger_health_check 呼叫 POST /admin/deployments/:id/health-check', async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ healthStatus: 'healthy' });
  });

  const client = await connectedClient();
  await client.callTool({ name: 'trigger_health_check', arguments: { deploymentId: 'dep-1' } });
  assert.equal(new URL(capturedUrl!).pathname, '/admin/deployments/dep-1/health-check');
});

test('REST API 回錯誤時，工具回傳 isError:true，訊息帶上游的 error.message，不是靜默失敗', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: { message: 'credentialId 不存在' } }, { status: 400 }));

  const client = await connectedClient();
  const result = await client.callTool({ name: 'create_deployment', arguments: { credentialId: 'x', publicModelName: 'y', providerModelId: 'z' } });

  assert.equal(result.isError, true);
  const content = result.content as { type: string; text: string }[];
  assert.match(content[0].text, /credentialId 不存在/);
});
