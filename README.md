# 個人版 LLM Router

把多個 LLM provider（OpenAI 相容 API、Anthropic 原生 API 等）統一包成同一組
OpenAI 相容的 `/v1/chat/completions` 介面，幫個人/單機規模的使用情境做
Fallback、健康檢查、用量與花費追蹤，並且提供 Web UI 與 MCP Server 兩種管理
方式。

## 專案緣起

這是「2026 IT邦幫忙鐵人賽」系列文章的實作專案。動機是參考公司內部一套
正式版 LLM Gateway 的架構設計，在個人規模上重新做一次，驗證那些
架構決策（Provider Adapter 抽象、Credential/Deployment 兩層設定、Fallback、
兩層健康檢查……）哪些是規模無關的通用道理、哪些只是企業級規模才需要的複
雜度。整個開發過程（含中間繞的彎路、踩過的坑）都記錄在 [`docs/`](docs/) 底
下，會陸續整理成系列文章發布。

## 核心功能

- **統一 Gateway**：`POST /v1/chat/completions`，OpenAI Chat Completions
  相容格式，背後可以接 OpenAI 相容 API（passthrough）或 Anthropic 原生 API
- **Credential / Deployment 兩層設定**：一組 Credential（provider 連線資
  訊）底下可以掛多個 Deployment（`public_model_name` → 實際 provider
  model），同一個 public model name 可以設定 priority 做 **Fallback**（主要
  失敗自動改打次要）
- **兩層健康檢查**：Credential 層輕量連線測試、Deployment 層真的送一次
  chat completion 驗證特定 model 可用，皆可排程自動執行
- **請求 Log + 用量/花費統計**：每個請求記錄 token 數、花費、延遲、成功/
  失敗，Dashboard 提供彙總與趨勢圖
- **Gateway API Key 層**：多組各自獨立的 API Key，各自可設定額度上限（含
  自動/手動重置）、可用 model 白名單、到期時間
- **Web UI 登入密碼保護**：`/admin/*` 管理介面用共用密碼保護
- **MCP Server**：讓 Claude Code、Claude Desktop 等 MCP client 連上後直接
  查詢/管理這個 router（11 個工具，詳見下方「MCP 使用方式」）

## 架構總覽

```
┌────────────────┐   /admin proxy   ┌─────────────────────────┐   passthrough   ┌──────────────┐
│  Next.js       │ ───────────────► │  Express                │ ──────────────► │  上游         │
│  Web UI (前端)  │                  │  /admin/*（登入密碼）    │                 │  Provider    │
└────────────────┘                  │  /v1/*   （Gateway Key）│                 └──────────────┘
                                     │                         │
┌────────────────┐   REST（/admin） │  SQLite（Drizzle ORM）  │
│  MCP Server    │ ───────────────► │                         │
│（獨立 subprocess）│                └─────────────────────────┘
└────────────────┘
```

- 後端：Express + Drizzle ORM + SQLite（單一 `.db` 檔案，個人單機規模不需
  要另外起一個資料庫服務）
- 前端：Next.js App Router，透過 `next.config.ts` 的 rewrites 把 `/admin/*`
  轉發到 Express 後端，`/v1/*`（Gateway）則是直接打後端自己的 port
- MCP Server 是**獨立的 subprocess**，只透過既有的 `/admin/*` REST API 操
  作，不直接連 DB——理由跟怎麼接上 Claude Code 見下方「MCP 使用方式」

## 快速開始

兩種方式都可以把服務跑起來，選一種就好：

### 方法一：直接用 Node 跑（推薦日常開發/自己用）

需要 Node.js 22+。

```bash
git clone https://github.com/tom0913685-code/router.git personal-llm-router
cd personal-llm-router

# 後端
npm install
cp .env.example .env
# 編輯 .env，至少要填 ENCRYPTION_KEY / SITE_SESSION_SECRET（見下方環境變數表）
npm run db:migrate
npm run build && npm run start   # 預設監聽 http://localhost:8787

# 前端（開新的 terminal）
cd frontend
npm install
cp .env.example .env
# 編輯 .env，SITE_PASSWORD 自己設一組，SITE_SESSION_SECRET 要跟後端那份完全一樣
npm run dev                       # 預設監聽 http://localhost:3000
```

打開 `http://localhost:3000`，用 `SITE_PASSWORD` 登入即可。

### 方法二：Docker（想省事，或想長期在背景常駐跑）

單一 image 把前端+後端打包在一起（細節見 [`Dockerfile`](Dockerfile)）：

```bash
docker build -t personal-llm-router .

docker volume create personal-llm-router-data

docker run -d --name personal-llm-router \
  -p 8787:8787 -p 3000:3000 \
  -v personal-llm-router-data:/app/data \
  -e ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e SITE_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e SITE_PASSWORD=your-own-password \
  personal-llm-router
```

資料庫掛在具名 volume（`personal-llm-router-data`）上，容器整個刪掉重建，
資料仍然保留。**注意**：MCP Server 沒有包進這個 image 裡，見下方「MCP 使用
方式」的說明。

## 環境變數說明

| 變數 | 位置 | 說明 |
|---|---|---|
| `DB_PATH` | 後端 | SQLite 檔案位置，預設 `./data/router.db`（Docker 部署時對應到 volume） |
| `ENCRYPTION_KEY` | 後端 | Credential 的 `api_key` 用 AES-256-GCM 加密儲存的金鑰。用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 產生 |
| `SITE_SESSION_SECRET` | 後端＋前端（**必須填同一個值**） | 登入 session token 的簽章金鑰，產生方式同上 |
| `SITE_PASSWORD` | 前端 | 進入 Web UI 的共用密碼 |
| `PORT` | 後端 | Gateway/Admin API 監聽的 port，預設 `8787` |
| `HEALTH_CHECK_INTERVAL_MINUTES` | 後端 | 排程健康檢查間隔（分鐘），預設 `30`，只有 `auto_health_check_enabled=true` 的 Deployment 會被排程掃到 |
| `BUDGET_RESET_SCAN_INTERVAL_MINUTES` | 後端 | API Key 額度排程重置的間隔（分鐘），預設 `60` |
| `BACKEND_URL` | 前端＋MCP Server | 前端 rewrites／MCP Server 打 `/admin/*` 的目標網址，同機部署時預設值（`http://localhost:{PORT}`）通常不用改 |

## 使用方式

### 設定第一個 model

1. 登入 Web UI → **Models** 頁面 → **Credentials** 分頁 → 新增一組 Credential
   （填上游 provider 的 base URL + API Key）
2. 切到 **Deployments** 分頁 → 新增 Deployment，指定 `public_model_name`
   （呼叫端要用的名稱）跟 `provider_model_id`（實際打給上游的名稱）——建立
   當下就會自動跑一次健康檢查
3. **API Keys** 頁面 → 新增一把 Key（可設額度上限/可用 model/到期時間），
   明文只會顯示一次，記得先複製

### 呼叫 Gateway

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <你的 API Key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<public_model_name>",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

Body 格式跟 OpenAI Chat Completions API 相容。

### MCP 使用方式

MCP Server 讓 Claude Code / Claude Desktop 之類的 MCP client 直接查詢/管理
這個 router（`list_models`、`create_deployment`、`get_usage_summary`、
`search_logs` 等 11 個工具）。

**MCP Server 不包在 Docker image 裡**——它的傳輸方式是 stdio（標準輸入輸
出），設計上就是要跟正在使用它的 MCP client **同一台機器**，讓 client 直接
把它 spawn 成子程序，不是像 Gateway 那樣走網路 port。所以不管 Gateway/Web
UI 是用 Node 直接跑還是用 Docker 跑，MCP Server 都要在你要用 Claude Code
的那台機器上，用 Node 另外手動啟動（即使 Gateway 本身是用 Docker 跑的，這
台機器上還是要 clone 專案＋`npm install`＋`npm run build` 一次，才有
`dist/mcp/server.js` 可以跑）：

```bash
BACKEND_URL=http://localhost:8787 SITE_SESSION_SECRET=<跟後端同一個值> node dist/mcp/server.js
```

用 Claude Code 的話可以直接註冊：

```bash
claude mcp add personal-llm-router -e BACKEND_URL=http://localhost:8787 -e SITE_SESSION_SECRET=<跟後端同一個值> -- node /path/to/personal-llm-router/dist/mcp/server.js
```

## 測試

```bash
npm test          # 後端單元/整合測試（node:test，186 個）
npm run test:e2e  # Playwright E2E（登入流程 + 完整 golden path，6 個）
```

E2E 測試用系統既有安裝的 Edge 瀏覽器（`channel: 'msedge'`），不會另外下載
Chromium——非 Windows 或沒裝 Edge 的環境需要自行修改
[`playwright.config.ts`](playwright.config.ts) 改用其他瀏覽器（例如
`npx playwright install chromium` 後把 `channel` 設定拿掉）。

## 已知限制 / 非目標

- 個人單機使用，不支援多租戶/Team/跨團隊 Budget
- v1 不支援 streaming、不支援 tool calling
- 只有一組共用登入密碼，沒有多帳號/權限分級概念
- 不做 Rate limit（請求頻率限制），只管額度/模型權限

完整的設計決策與開放問題記錄在 [`docs/requirements/`](docs/requirements/)。

## License

[MIT](LICENSE)
