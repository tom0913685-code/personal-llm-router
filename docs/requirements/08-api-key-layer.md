# 需求文件：Gateway API Key 層（取代 ROUTER_API_KEY）

## 目的

現況 `ROUTER_API_KEY` 是一組固定 key，同時保護 `/v1/*`（Gateway）跟
`/admin/*`（Web UI 後端），沒有分級、沒有預算、沒有辦法知道「這次請求是
誰打的」。

**2026-09-19 決定：整個拿掉 `ROUTER_API_KEY`**，兩個入口的身分驗證責任拆
給兩個不同機制：

- `/admin/*`（管理 Web UI 本身）：改用登入密碼的 session（見
  `06-site-auth.md`，範圍隨這次決定擴大，`/admin/*` 本身也要驗證 session，
  不能只擋 Next.js 頁面——否則直接打後端 port 就能繞過登入）
- `/v1/*`（Gateway）：改用這份文件定義的**新 API Key 層**——目的是讓使用
  者可以把這種 key 放進自己的程式碼裡（不像現在的 `ROUTER_API_KEY` 一把
  key 打天下、外流等於後端全開），外流只影響單一把 key 的額度跟權限，可
  以單獨停用/重新產生，不影響其他 key 或整個系統

這把新 key **只能用 Gateway 功能**，完全碰不到 `/admin/*`（不能改設定、
不能看其他 key 的資訊）。

## 資料模型（已定案）

新增 `api_keys` 表：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | text (uuid) | |
| `name` | text | 使用者自訂識別名稱（例如 "my-script"），方便在清單裡認 |
| `key_hash` | text | SHA-256(明文 key)，**只存雜湊，不可逆**——這把 key 從
  頭到尾只需要拿來比對，沒有任何情境需要拿回明文，雜湊比可逆加密更安全 |
| `key_prefix` | text | 明文 key 前幾個字元（例如 `sk-abc12...`），純粹給
  清單畫面辨識用，不構成安全風險（猜不出剩下的部分） |
| `enabled` | boolean，預設 true | 停用＝軟刪除，不做硬刪除（沿用
  Credential/Deployment 的既有慣例） |
| `allowed_models` | JSON（`string[] \| null`） | `null` = 不限制，可以打
  任何啟用中的 `public_model_name`；非 null = 白名單，只能打清單內的
  model。用 JSON 欄位而不是另開一張 join table，跟 `provider_error` 的做
  法一致（個人版規模不需要為了這種小陣列多一張表） |
| `budget_limit` | real，nullable | 這期（見 `budget_reset_day`）的花費上
  限，`null` = 無上限 |
| `current_spend` | real，預設 0 | 這期已花費，每次請求後累加（成功請求
  的實際花費；失敗請求 `cost` 本來就是 0，不用特殊處理） |
| `budget_reset_day` | integer 1-31，nullable | 每月第幾天自動重置
  `current_spend`；`budget_limit` 是 `null`（無上限）時這個欄位沒有意義，
  但還是讓它可以獨立設定（先設定重置日、之後才設額度，不用互相綁死） |
| `last_reset_at` | text (ISO)，nullable | 上次重置（自動或手動）的時間 |
| `expires_at` | text (ISO)，nullable，**預設 null（永不過期）** | 超過這個
  時間點，這把 key 直接視為無效，不管 `enabled`/`budget_limit` 狀態 |
| `created_at` / `updated_at` | text (ISO) | |

`request_logs` 新增一欄 `api_key_id`（nullable，`references(() => apiKeys.id, { onDelete: 'set null' })`）
——跟 `deployment_id` 一樣的模式：key 被停用/之後真的被刪除都不影響歷史
log，只是外鍵被清空。這欄用來回答「這把 key 花了多少錢」，不用另外做彙
總表，複用 `04-usage-cost.md` 已經有的「先撈符合條件的列、用 JS 加總」做
法即可（`GET /admin/logs/summary` 之後可以加 `apiKeyId` 篩選）。

## 功能需求：驗證與額度檢查（Gateway 端）

依序檢查，任何一關沒過就擋掉，**都不寫入 `request_logs`**（跟現在
`require-api-key.ts` 驗證失敗不寫 log 是同一個道理——這個階段還沒解析出
`deployment_id`，沒有 snapshot 資料可以附著，見 `02-gateway.md` 的既有慣
例）：

1. **格式檢查**：`Authorization: Bearer <key>` 格式不對 → 401
2. **查表**：把明文 key 算 SHA-256，去 `api_keys` 查 `key_hash` 有沒有對
   應的列，查不到 → 401
3. **啟用狀態**：`enabled = false` → 401
4. **到期時間**：`expires_at` 不是 null 且已經過了 → 401
5. **預算檢查（有惰性重置）**：先檢查「這期是否已經該重置」（見下方
   「預算重置」），重置完再檢查 `current_spend >= budget_limit`（`budget_limit`
   是 null 就跳過這關）→ 超過就回 **429**，`type: 'insufficient_quota'`
   （沿用 OpenAI 對「額度用完」的慣例，跟 429 通常代表的「rate limit、可
   以重試」不完全一樣，但這是 OpenAI 相容工具比較認得的錯誤型態）
6. **模型權限**：`allowed_models` 不是 null，且 `body.model` 不在清單裡
   → **403**，`type: 'permission_error'`（這關要在 body 解析出
   `model` 欄位之後才能做，不像前面四關可以在最外層 middleware 一次做完）

通過全部檢查後才進入現有的 `resolveDeploymentCandidates` → Fallback 流
程；請求完成後（成功或失敗）除了原本寫 `request_logs`（帶上
`api_key_id`），還要把這次的 `cost` 累加進這把 key 的 `current_spend`。

## 功能需求：預算重置

- **自動重置（惰性）**：每次用這把 key 驗證時，先比對「現在的日期」跟
  `last_reset_at` + `budget_reset_day`，如果已經跨過重置點，先把
  `current_spend` 清零、`last_reset_at` 更新成現在，再繼續檢查額度——這
  樣不需要额外的背景排程就能保證「拿來用的時候額度一定是最新的」
- **排程掃描（讓沒被呼叫的 key 在畫面上也能顯示正確狀態）**：比照
  `src/health/scheduler.ts` 的既有模式，另外開一個排程（可以共用同一個
  `setInterval`，或獨立一個，間隔抓現有的 `HEALTH_CHECK_INTERVAL_MINUTES`
  同等級的頻率即可），定期掃過全部 `budget_reset_day` 不是 null 的 key，
  該重置的就重置——理由：如果一把 key 這個月完全沒被呼叫過，惰性重置永
  遠不會被觸發，Web UI 上會一直顯示上個月的舊 `current_spend`，跟「這個
  月還沒花錢」的事實不符
- **手動重置**：Web UI 提供「立即重置」按鈕，對應
  `POST /admin/api-keys/:id/reset-budget`，直接把 `current_spend` 清零、
  `last_reset_at` 設成現在（不等排程或惰性觸發）

## 功能需求：Web UI

新增一個獨立頁面/導覽項目「API Keys」（跟 Models/Logs 平行，不是塞進
Models 頁面底下——這批 key 是給外部程式碼呼叫 Gateway 用的，跟「設定上游
provider」是不同性質的東西）：

- **清單**：名稱、`key_prefix`、啟用狀態、額度使用情況（`current_spend`
  / `budget_limit`）、重置日、到期時間、模型權限（顯示「不限制」或白名單
  數量）
- **新增**：名稱、額度上限（可留空＝無上限）、重置日（預設抓「今天的日
  期」，可改）、到期時間（可留空＝永不過期）、模型權限（多選現有啟用中
  的 `public_model_name`，預設不勾＝不限制）——送出後**明文 key 只顯示一
  次**（跳出「請立即複製，關閉後就看不到了」的提示），之後畫面上只會看
  到 `key_prefix`
- **編輯**：可改名稱、額度、重置日、到期時間、模型權限、enabled；**不能
  改/看 key 本身**
- **重新產生**：換一組新的明文 key（同一筆記錄，`id`/`name`/額度設定都
  不變），一樣只顯示一次
- **立即重置額度**：見上方
- **停用**：`enabled = false`，不做硬刪除

## 已定案

- **雜湊儲存**：`key_hash` 用 SHA-256，不用可逆加密——這把 key 只需要比
  對，不像 Credential 的 `api_key` 之後還要解密拿去打上游，兩者性質不同，
  不能照抄同一套加密方案
- **可以同時存在多組 key**，各自獨立的 enabled／額度／重置日／到期時
  間／模型權限，互不影響——符合「洩漏一把不影響其他」的設計目的
- **`budget_limit`／`expires_at` 都預設「無限制」**：新建 key 時兩者都留
  空就是完全沒有額度上限、永不過期的 key（等同現在 `ROUTER_API_KEY` 的行
  為），使用者自己決定要不要加限制
- **超過額度回 429、模型不在白名單回 403**：兩種是不同性質的拒絕（一個
  是「額度用完，換個週期或加額度就能再用」，一個是「這把 key 天生就不能
  打這個 model」），用不同狀態碼跟 `type` 讓呼叫端可以分開處理
- **驗證失敗（含額度/權限）都不寫 `request_logs`**：跟現有 `require-api-key.ts`
  的行為一致，這個階段沒有 deployment 可以附著

## 非目標（v1 不做）

- 每個 key 綁定多個使用者/團隊概念（沿用「個人單機使用」的定位，key 是
  單一使用者自己配發給自己不同程式用的，不是給不同人用的）
- 額度用完時的主動通知（email/webhook）——跟 `01-config-management.md`
  對失敗通知的態度一致，使用者自己進 Web UI 看
- 依 model 分別設定不同額度（目前只有一個總額度，不分「這個 model 花多
  少、那個 model 花多少」）
- Rate limit（每秒/每分鐘請求數限制）——這份文件只管「額度」跟「模型權
  限」，不管請求頻率
- 過期 key 自動被刪除或自動停用 `enabled` 欄位——`expires_at` 跟
  `enabled` 是兩個獨立檢查，過期不會反過來把 `enabled` 改成 false，Web UI
  用比對現在時間跟 `expires_at` 動態顯示「已過期」狀態就好，不需要背景
  工作去同步一個衍生欄位

## 開放問題（待確認）

無。MCP server 如何取得 `/admin/*` 存取權限已在 `07-mcp-server.md`
定案（2026-09-23）：直接用共用的 `SITE_SESSION_SECRET` 自己簽 session
token，不涉及這批 `api_keys`——MCP 也明確不開放管理 `api_keys` 的工具。
