# 需求文件：Gateway/Proxy 入口

## 目的

提供 OpenAI-compatible 的 HTTP 入口，讓現有工具（Cursor、各種 SDK、Claude
Code 等）只要改 `baseURL` 就能指向這個 Router。

## 功能需求

- 至少實作 `POST /v1/chat/completions`，接受 OpenAI-shape 的 request body
- 依 `request.model` 呼叫路由模組（`03-routing.md`）決定要用哪個
  Provider Adapter
- 呼叫 Adapter 的 `chat()`，取得 `UnifiedChatResponse`
- **把 `UnifiedChatResponse` 組回 OpenAI-shape response** 再回給 client
  （例如 `{ choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens, completion_tokens } }`）——這件事目前沒有任何模組
  文件明講由誰負責，這裡明確定義：**由 Gateway 層負責**，Adapter 只回最小
  共同格式，不用知道 client 期待的完整 OpenAI response 結構
- Adapter 拋出的 Error 需轉換成合理的 HTTP 狀態碼 + OpenAI-compatible 錯誤
  格式（`{ error: { message, type } }`），方便既有 SDK 直接解析
- client 若傳 `stream: true`，回傳明確的 400 錯誤（例如
  `"streaming not supported in this version"`），**不能默默忽略**改用
  非串流回應——避免 client 端誤判請求成功但行為不對
- 收到請求時產生一個 `requestId`（`randomUUID()`），設進回應 header
  `x-request-id`；此請求後續寫入請求 log（`04-usage-cost.md`）時，用**同
  一個** `requestId` 存進 `request_logs.request_id`，讓 client 拿到的
  header 值可以直接對到一筆 log 記錄——**例外**：驗證失敗在還沒解析出
  deployment 之前就發生時（`stream:true`、`model` 缺失/找不到候選、body
  格式驗證失敗），刻意不寫 log，`x-request-id` 這時候查不到對應紀錄；驗
  證失敗在進到 Gateway route 之前（body 解析失敗、身份驗證失敗）則連
  header 都不會有。完整的情境拆解見 `../provider-adapter-spec.md` 的
  「已知限制」段落
- 每次請求完成後（成功或失敗），把結果連同 `requestId` 寫入請求 log 記錄
  模組（`04-usage-cost.md`，同步寫入，不用 Queue）——見上一點的例外情況
- 驗證呼叫端身份：**2026-09-19 修訂**，原本是比對固定的 `ROUTER_API_KEY`，
  改成比對 `08-api-key-layer.md` 定義的 API Key 層（雜湊查表＋啟用/到
  期/預算/模型權限檢查），不符合任何一關就回對應的狀態碼（401/403/429，
  細節見該文件）。**已定案**，理由見下方「已定案」段落

## 已定案

- **身份驗證**：**2026-09-19 修訂**——不再是單一固定 key 比對，改用
  `08-api-key-layer.md` 的多組 API Key（各自可設額度上限、模型權限、到
  期時間）。理由跟原本「即使 v1 只跑在本機也先做」一致（避免之後對外開
  放時要回頭補），額外多解決的問題是「一把 key 打天下、外流等於後端全
  開」——現在外流一把 key 只影響它自己的額度跟權限範圍
- **服務架構**：Web UI 的後端 API 與本 Gateway **合併成同一個 Node
  process**，`/v1/*` 給 client（Cursor 等工具）呼叫、`/admin/*` 給 Web UI
  呼叫（見 `05-web-ui.md`）。**2026-09-19 修訂**：`/admin/*` 改用登入密
  碼的 session 驗證（見 `06-site-auth.md`），不再跟 `/v1/*` 共用同一套
  驗證機制——兩個入口的使用情境不同（一個是瀏覽器登入、一個是程式碼帶
  key），拆開後兩邊都能各自設計更貼合情境的驗證方式
- **部署方式**：v1 手動啟動（`npm run start`），不做 pm2/systemd 之類的
  常駐服務設定；等實際穩定要長期掛著用時再補
- **Port**：預設監聽 `8787`（改用非常見 port，避免跟開發機上其他常跑在 3000 的服務衝突），可用環境變數 `PORT` 覆蓋

## 非目標（v1 不做）

- `/v1/embeddings`、`/v1/images` 等其他端點
- Tool calling / function calling 的 passthrough
- Streaming
- 開機自動啟動/常駐服務設定（pm2、systemd unit）

## 開放問題（待確認）

無。
