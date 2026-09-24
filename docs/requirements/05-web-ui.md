# 需求文件：簡易 Web UI

## 目的

用最小成本呈現用量與設定資訊，加上手動健康檢查按鈕。你先前確認這塊「也會
做簡單呈現版」，範圍刻意保持精簡。

## 功能需求

- **用量儀表板頁面**：顯示今日/本週/本月花費總計、錯誤率，依
  Credential/Deployment（public_model_name）拆分的表格或簡單圖表（資料
  來源：`04-usage-cost.md` 的彙總查詢）
- **請求 Log 明細頁面**：列表顯示每一筆請求（時間、`request_id`、
  public_model_name、tokens、cost、latency、狀態），依時間區間/
  deployment/status 篩選＋分頁；失敗的請求點開可看到 `error_code`／
  `error_message`／遮罩後的 `provider_error`（資料來源：`04-usage-cost.md`
  的明細查詢）
- **設定管理頁面**：兩個平行 Tab——
  - Credentials Tab：清單（名稱、adapter_type、enabled），表單可新增/編輯
    （base_url、api_key、enabled）
  - Deployments Tab：清單（public_model_name、provider_model_id、priority、
    所屬 Credential 名稱、定價、enabled、`auto_health_check_enabled`、
    health_status），表單可新增/編輯——**2026-09-18 修訂**：原本規劃是
    「Credential 底下巢狀顯示 Deployment」兩層結構，實作時選了兩個平行
    Tab（`CredentialsTab`/`DeploymentsTab`），理由是巢狀結構在個人版資料
    量下沒有實際使用體驗上的好處，平行 Tab 反而讓兩邊的 CRUD 操作互相獨
    立、不用處理展開/收合狀態；Deployments 清單依 `public_model_name` +
    `priority` 排序、附上所屬 Credential 名稱，仍能看出同一個 model 底下
    有哪些候選，不會因為拆開而失去這個資訊
  - 呼應 `01-config-management.md` 的「已定案」，v1 **不是唯讀**，但表單
    不需要多步驟精靈或複雜驗證流程
- **兩層手動健康檢查**（2026-09-19 修訂，見 `provider-adapter-spec.md`
  「兩層健康檢查」）：
  - Credentials 分頁每一列一個「測試連線」按鈕，呼叫該 Credential 的
    Adapter `.ping()`，只驗證連線/認證，結果寫回這筆 Credential 自己的
    `connectivity_status`/`last_latency_ms`/`last_error`
  - Deployments 分頁每一列一個「手動檢查」按鈕，改成真的呼叫該
    Deployment 指定的 `provider_model_id` 送一次最小化請求，結果寫回這
    筆 Deployment 的 `health_status`/`last_latency_ms`/`last_error`；
    **新增 Deployment 時也會自動跑一次**，排程（`auto_health_check_enabled`）
    2026-09-21 起也改用這套深層檢查，不用等使用者手動點或等排程輕量連
    線探測才發現 model 設定錯了
  - 健康度徽章的 hover 詳情額外顯示「上次手動檢查」時間
    （`last_manual_checked_at`，2026-09-21 新增），跟不分來源的「上次檢
    查」分開——只有透過按鈕觸發才會更新，讓使用者能分辨這個健康狀態是
    自己剛確認過的、還是排程/建立時自動跑出來的
  - 兩層分開顯示、分開觸發：Credential 連線正常不代表底下每個
    Deployment 的 model 都設定正確，兩者是不同的問題
- 需要一個後端 API 層讓前端呼叫（彙總查詢 API、Credential/Deployment
  CRUD API、健康檢查觸發 API）——**已定案**與 Gateway 合併成同一個 Node
  process，掛在 `/admin/*` 路由前綴下（見 `02-gateway.md`）
- **API Keys 管理頁面**（2026-09-19 新增，見 `08-api-key-layer.md`）：跟
  Models/Logs 平行的獨立導覽項目，管理 Gateway 用的多組 API Key（新增/
  編輯/停用/重新產生/立即重置額度），不是塞進「設定管理頁面」底下——這
  批 key 是給外部程式碼呼叫 Gateway 用的，跟「設定上游 provider」性質不
  同

## 已定案

- **服務架構**：`/admin/*` API 與 Gateway 的 `/v1/*` 同一個 process，
  簡化個人版部署
- **`/admin/*` 的驗證方式**：**2026-09-19 修訂**——原本是跟 `/v1/*` 共用
  同一組固定 `ROUTER_API_KEY`；`ROUTER_API_KEY` 整個拿掉後，`/admin/*`
  改用登入密碼的 session 驗證（見 `06-site-auth.md`，該文件的範圍也隨這
  次決定擴大到直接保護 `/admin/*`，不只是 Next.js 頁面本身）。`/v1/*`
  則改用 `08-api-key-layer.md` 的多組 API Key，兩個入口從「共用一組
  key」變成「各自有各自的驗證機制」
- **前端技術選型：Next.js App Router + React**（2026-09-14 修訂：原本規劃
  Vite + React SPA，交接時為了跟另一個開發對話的 `main` 分支一致改用
  Next.js，UI/頁面內容原封不動搬過去，過程見 `docs/article-notes.md`）

## 非目標（v1 不做）

- 多帳號/多使用者概念（登入密碼跟 API Key 都是「單一使用者自己用」的設
  計，不是給不同人各自登入）
- 即時 WebSocket 更新（重新整理頁面就好，不用推播）
- Credential/Deployment 設定的版本歷史/稽核紀錄（呼應
  `01-config-management.md`）

## 開放問題（待確認）

無。
