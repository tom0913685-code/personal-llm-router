# 需求文件：請求 Log 記錄（含 Usage/Cost）

## 目的

記錄每一次請求的完整結果（成功或失敗），供 Web UI 查詢明細、計算費用、看
錯誤率。這是先前討論中你特別強調「蠻重要」的模組。

> **修訂說明（2026-09-10）**：原本只規劃「Usage/Cost 記錄」（單純算費用），
> 你另外提出要有一個更完整的「請求 log 記錄」模組。參考另一套正式版 Router 的
> `SpendLog` 設計調查後，確認兩者本來就是同一張表在做的事（每個請求一筆
> log，metadata 含 token/cost/latency/status/錯誤資訊），**因此本文件直
> 接合併、取代原本的 Usage/Cost 規劃**，`03-routing.md`/`05-web-ui.md`
> 等其他文件裡對「Usage/Cost 記錄」的引用，指的都是本文件。

## 功能需求

- 每次請求結束後（成功或失敗）**同步寫入一筆** `request_logs` 記錄，不用
  Queue/批次寫入——個人版 QPS 低，直接在請求完成後 `INSERT` 一筆即可，比
  照另一套正式版 Router 的 Redis Queue + 批次 flush 對個人版是不必要的複雜度
- **`request_id` 貫穿 HTTP header／log／DB**：Gateway 收到請求時產生一個
  `requestId`（例如 `randomUUID()`），全程只用這一個值——回應 header
  `x-request-id`、寫進 `request_logs.request_id`、錯誤訊息裡引用的都是同
  一個值。這修正了另一套正式版 Router 現存的缺口（它的 `x-request-id`／
  `SpendLog.id`／Langfuse `traceId` 三者互不相同也沒建立對應，導致同一次
  請求沒辦法端到端追蹤）
- 記錄欄位：`request_id`、`deployment_id`、`public_model_name`（快照）、
  `provider_model_id`（快照）、`input_tokens`、`output_tokens`、`cost`、
  `status`（`success` | `error`）、`status_code`（Gateway 回給 client 的
  HTTP 狀態碼）、`error_code`、`error_message`、`provider_error`（遮罩後
  的 JSON）、`latency_ms`、`fallback_used`、`fallback_attempts`、
  `created_at`（後兩個欄位 2026-09-14 新增，見 `03-routing.md` 的 Fallback
  修訂）
- **失敗的請求也要記錄**（`cost` 算 0），方便之後追蹤某個 deployment 的
  失敗率，而不是只看得到成功的呼叫
- **`provider_error` 寫入前先做基本遮罩**：偵測欄位名稱是否命中常見敏感
  關鍵字（`password`、`api_key`、`token`、`secret`、`authorization` 等，
  可參考另一套正式版 Router 的 `audit-log.service.ts` 的 `scrub()` 作法——用
  regex 比對欄位名稱後整個值換成 `[REDACTED]`），命中就整個值換成
  `[REDACTED]` 再存。**已知限制**：這只防得住「欄位名稱看得出是敏感資料」
  的情況，防不住「錯誤訊息裡以自然語言夾帶敏感內容」（例如某段文字裡剛
  好回顯了使用者輸入的一部分），這點另一套正式版 Router 也沒有處理，先明確記
  錄成已知限制，不假裝已經解決
- 定價（每百萬 token 輸入/輸出單價）從 `model_deployments` 表讀取，請求
  當下就用當時的定價算好存進 `cost` 欄位（見下方「已定案」）
- 提供查詢能力給 Web UI 使用：
  - **明細列表**：依時間區間、`deployment_id`／`public_model_name`、
    `status` 篩選，分頁回傳
  - **彙總查詢**：依時間區間（今日/本週/本月/自訂）、依 Deployment 分組
    加總花費與 token 數
  - **錯誤率**：依時間區間統計 `status = 'error'` 的佔比
  - **Fallback 觸發率**：依時間區間統計 `fallback_used = true` 的佔比，
    讓使用者知道哪個 model 常常需要靠備援才能成功，是該檢查主要
    deployment 的訊號
- **每次請求（不論嘗試了幾筆候選）只寫一筆 log**：`fallback_attempts` 記
  「總共試了幾筆」，中間失敗的嘗試不個別寫 log，避免拆成多筆造成查詢/
  統計複雜度暴增

## 已定案

- **不與原本 04 拆成兩個模組**：這份文件直接是完整的請求 log 記錄，涵蓋
  原本 Usage/Cost 的全部需求
- **定價不獨立成表，掛在 `model_deployments` 上**（沿用先前決定）：同一
  個 model 在不同 deployment 收費可能不同，`model_deployments` 已經是獨
  立表，不需要再多一張 `model_pricing` 表
- **`request_logs` 用 `deployment_id` 當外鍵**（`onDelete: SET NULL`，
  比照另一套正式版 Router），並在寫入當下把 `public_model_name`／
  `provider_model_id` 存成快照欄位——即使之後這個 deployment 被刪除或改
  名，歷史 log 顯示的名稱不受影響
- **儲存方式：統一同一個 SQLite 檔案**，`credentials`、
  `model_deployments`、`request_logs` 都放同一個 `.db` 檔
- **費用計算時機：請求當下算好存死值**，之後定價更新不影響歷史紀錄
- **寫入方式：同步直接寫入**，不做 Queue/批次
- **資料保留：不設 TTL，全部留著**——個人版單人使用，資料量遠低於企業版
  規模（另一套正式版 Router 才需要 180 天 TTL + 每日排程清除），沒有清除的急迫
  性；之後如果真的發現資料庫肥大到有感，再回頭加清除機制不遲
- **索引**：至少在 `created_at` 上建索引（列表/彙總查詢都會用到時間範圍
  篩選），`deployment_id` 也建一個（依 model 分組查詢會用到）

## 非目標（v1 不做）

- 跨團隊/跨使用者的 budget 上限與警示、rate limit 相關的 `status` 分類
  （個人版沒有 Virtual Key/Team/User 概念，`status` 只分 `success`/
  `error`，不比照另一套正式版 Router 細分 `blocked`/`budget_exceeded`/
  `rate_limited`）
- `ttfb_ms`（time-to-first-byte）——v1 不支援 streaming，這個欄位沒有意
  義，等之後真的加 streaming 再一併補
- Queue + 批次寫入
- 資料保留 TTL / 自動清除排程
- CSV 匯出（Web UI 先做畫面呈現，匯出功能之後有需要再加）
- 自動從廠商官網爬取最新定價（定價表手動維護）
- 歷史費用隨定價表更新自動重算
- 防止錯誤訊息「以自然語言夾帶敏感內容」的洩漏（僅做欄位名稱層級的遮罩，
  見上方「已知限制」）

## 開放問題（待確認）

無。
