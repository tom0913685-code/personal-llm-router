# 需求文件：MCP Server

## 目的

讓 AI agent（Claude Code、Claude Desktop 等 MCP client）接上這個 router
時，透過標準化的 MCP 工具立刻查得到「這個 service 有哪些 model 可以用、
現在健康度/花費如何」，也能請 agent 代為管理 Credential/Deployment，不用
另外去讀文件或記 REST API 的網址跟格式。

## 範圍（已定案）

- **唯讀查詢 + 管理寫入**：查 model/deployment/花費/log，也能新增、編輯、
  停用 Credential 跟 Deployment
- **不做**：不把 `/v1/chat/completions` 包成 MCP tool——這個 router 本來
  就是給其他工具（Cursor、Claude Code 等）當 `baseURL` 用的，AI agent 如
  果要送 chat 請求，直接改 `baseURL` 指過來就好，不需要再透過 MCP 多繞一
  層
- **傳輸方式：stdio**——當一個本機 subprocess 跑，寫進 Claude Code/
  Claude Desktop 的 MCP 設定檔就能接上，不另外開 network port、不需要自
  己處理 HTTP 層的驗證

## 架構決定（已定案）

- **MCP server 是 `/admin/*` REST API 的 thin client，不直接碰 DB**——
  這點特別記一下為什麼：如果 MCP server 直接 import 專案內部的 db/schema
  操作 SQLite，會撞上 `src/routing/adapter-cache.ts` 的 in-memory cache
  是 process-local 的問題——MCP server 是獨立的 subprocess，跟正在跑的
  Express server 是不同的 process，各自的 `Map<credentialId, adapter>`
  互不相通。如果 MCP 直接寫 DB 改了某個 credential 的 api_key，Express
  process 的 adapter cache 完全不知道要 invalidate，會重現「改了 key、
  舊 adapter 還在用舊 key」這個已經在 `src/routing/adapter-cache.ts` 修過
  一次的問題（`@article topic:adapter-cache-race`），只是換了一個新的
  觸發路徑。改成 MCP server 呼叫既有的 `/admin/*` REST API（跟前端一樣的
  路徑），mutation 一律經過正在跑的 Express process，`invalidateAdapter()`
  自然會被正確呼叫到
- **這代表 MCP server 運作的前提是 Express backend（`npm run start`）本
  來就要在跑**——沒有 backend，MCP server 什麼都做不到，跟 Gateway/Web UI
  的前提一致，不是額外限制
- **驗證（2026-09-23 定案）**：MCP server 直接用跟後端共用的
  `SITE_SESSION_SECRET`，呼叫既有的 `createSessionToken()`
  （`src/auth/session.ts`）自己簽一顆合法的 session token，每次呼叫
  `/admin/*` 都用這顆 token 當 `Cookie: site_session=<token>`
  ——不用真的走一次登入流程換 cookie（候選方案之一是 MCP 帶
  `SITE_PASSWORD` 打 `/api/login` 換 cookie，但這樣還要多知道前端的網址、
  處理 cookie 快取跟過期重新登入，比直接簽 token 複雜，且兩種做法都一樣
  需要 MCP process 能讀到跟後端共用的機密值，改用簽 token 沒有多付出額
  外的信任成本）。這代表 MCP server 的 `.env` 需要跟後端 `.env` 共用
  `SITE_SESSION_SECRET`（跟 `frontend/.env` 目前的做法一致）。
- **技術選型**：官方 `@modelcontextprotocol/sdk`（TypeScript），用
  `McpServer` + `StdioServerTransport`，工具輸入用 Zod schema 驗證
- **全部用 MCP tools 實作，不使用 resources/prompts primitive**——讀跟寫
  都是「呼叫一個動作拿到結果」，用同一種 primitive 表達比較單純，不需要
  為了唯讀查詢另外去學一套 resources 的 URI 定址方式

## 功能需求：工具清單

參考另一套正式版 Router 的 MCP 工具（`list_models`／`create_deployment`
等命名風格），但依這個專案實際的資料模型砍掉不存在的概念（沒有 virtual
key、沒有 team、沒有 per-key spend、沒有 deployment weight）：

**查詢類**
- `get_integration_guide`：回傳這個 service 的用途說明、`/v1/chat/completions`
  的 `baseURL`／認證 header 格式、目前有哪些 `public_model_name` 可以呼叫
  ——**這是讓 agent「馬上了解用途」最直接的工具，MCP server 連線時的
  server description 也要講同樣的內容，不用等 agent 主動呼叫這個工具才
  知道**。**2026-09-19 更新**：認證格式的說明要改成
  `08-api-key-layer.md` 的 API Key 層（`Authorization: Bearer <key>`，
  這把 key 是使用者自己去 Web UI 的「API Keys」頁面申請的，不是固定的
  `ROUTER_API_KEY`）
- `list_models`：列出目前啟用中的 `public_model_name`（給 agent 決定要打
  哪個 model 名稱）
- `list_deployments`：完整 Deployment 清單（priority、health_status、定
  價、`auto_health_check_enabled`），對應 `GET /admin/deployments`
- `list_credentials`：Credential 清單（不含 api_key，跟 REST API 的
  `toSafeCredential()` 一樣的安全欄位），對應 `GET /admin/credentials`
- `get_usage_summary`：花費/請求數/錯誤率/Fallback 觸發率彙總，對應
  `GET /admin/logs/summary`，參數（`rangeHours`）對應過去
- `search_logs`：請求明細查詢，對應 `GET /admin/logs`，篩選參數
  （`rangeHours`／`publicModelName`／`deploymentId`／`status`／分頁）對應
  過去

**管理類**
- `create_credential` / `update_credential`：對應 `POST`／`PATCH
  /admin/credentials`，包含 enable/disable
- `create_deployment` / `update_deployment`：對應 `POST`／`PATCH
  /admin/deployments`，包含 enable/disable、改 priority
- `trigger_health_check`：對應 `POST /admin/deployments/:id/health-check`

**明確不做的工具**：`set_deployment_weight`——這是另一套正式版 Router 因為有
Load Balancing 才需要的工具，這個專案的 `03-routing.md` 已經明確排除這
個概念，MCP 工具清單不應該無中生有加回來。

**2026-09-23 定案**：不幫 `08-api-key-layer.md` 的 `api_keys` 開對應的
MCP 管理工具——這批 key 的用途是讓使用者把外部程式碼跟真實金鑰隔開，建
立/重新產生/調整額度上限刻意只留在 Web UI 操作，不開放給 AI agent 透過
MCP 自己管理，降低「agent 自己開通更多存取權限」這個風險面。`list_*`／
`get_usage_summary`／`search_logs` 這些既有的唯讀查詢工具不受影響（本來
就沒有回傳 API Key 明文或雜湊）。

## 非目標（v1 不做）

- 把 `/v1/chat/completions` 包成 MCP tool（見上方範圍說明）
- HTTP/SSE 傳輸（只做 stdio；之後真的需要遠端 agent 連線再評估）
- Deployment weight 相關工具（這個專案的路由邏輯沒有對應概念，見上方
  「明確不做的工具」）
- 寫入操作的額外確認機制（例如要求 agent 呼叫前先跑一次 dry-run）——跟
  REST API 本身承擔一樣的風險，不因為多了 MCP 介面而加碼

## 開放問題（待確認）

無。
