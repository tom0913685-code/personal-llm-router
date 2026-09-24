# 需求文件：設定/憑證管理

## 目的

儲存並管理 Credential（API key）與 Model Deployment（model 名稱對應）等設
定，供 Adapter Factory（見 `provider-adapter-spec.md`）與路由模組讀取使用。

> **修訂說明（2026-09-10）**：原本規劃單一 `providers` 表（key 與
> allowed_models 綁在一起），參考另一套正式版 Router 實際的分層設計後改為
> **`credentials` + `model_deployments` 兩張表**（跳過那套設計裡 `Model`
> M:N 路由層，因為 v1 不做 load balancing/fallback）。詳見
> `provider-adapter-spec.md` 的「資料表設計」段落。

## 功能需求

- 儲存 Credential 清單，欄位比照 `provider-adapter-spec.md` 的
  `credentials` 資料表（`adapter_type`、`base_url`、`api_key_encrypted`、
  `enabled`）
- 儲存 Model Deployment 清單，欄位比照 `model_deployments` 資料表
  （`credential_id`、`public_model_name`、`provider_model_id`、`priority`、
  `input_cost_per_million`、`output_cost_per_million`、`enabled`、
  `auto_health_check_enabled`、健康狀態欄位）。**一個 `public_model_name`
  可以對應多筆 deployment，依 `priority` 排序當 Fallback 候選**（見
  `03-routing.md`）——2026-09-14 修訂：原本是單獨 UNIQUE 約束只能對應一筆，
  現在改成 `(public_model_name, priority)` 複合唯一索引
- **兩層健康檢查（2026-09-19 修訂）**：原本手動/排程共用同一套只驗連線
  的 `.ping()`，使用者實測發現「`provider_model_id` 打錯，健檢卻顯示健
  康」，改成兩層分開，見 `provider-adapter-spec.md`「兩層健康檢查」：
  - **Credential 層（連線）**：`POST /admin/credentials/:id/health-check`，
    呼叫 Adapter `.ping()`，結果寫回 `credentials` 表自己的
    `connectivity_status`/`last_checked_at`/`last_latency_ms`/`last_error`
  - **Deployment 層（model）**：`POST /admin/deployments/:id/health-check`，
    改成真的送一次最小化 chat 請求（用這個 deployment 的
    `provider_model_id`），結果寫回這筆 deployment 的
    `health_status`/`last_checked_at`/`last_latency_ms`/`last_error`；
    **新增 deployment 時也會自動跑一次**，不用等手動點才發現 model 設定
    錯了；手動觸發時額外寫回獨立的 `last_manual_checked_at`（2026-09-21
    新增），跟不分來源的 `last_checked_at` 分開追蹤「使用者自己上次確認
    是什麼時候」
- 排程健康檢查：`auto_health_check_enabled = true`（且 deployment/credential
  都 `enabled = true`）的 deployment 會被排程掃描，間隔由環境變數
  `HEALTH_CHECK_INTERVAL_MINUTES`（預設 30）決定，逐筆循序執行，單筆失敗
  不中斷整個掃描。**2026-09-21 修訂**：排程改成也跑 Deployment 層的深層
  model 檢查（不再只做輕量連線探測），使用者明確要求排程要能抓到「model
  打錯/不存在」這種問題——代價是開啟這個排程開關代表接受持續性的 token
  成本，開關本身仍是 per-deployment 選擇性啟用
- 支援停用 Credential 或 Deployment（`enabled = false`），**不做硬刪除**
  ——避免刪掉後 Usage/Cost 記錄的外鍵關聯找不到對應資料
- `api_key` 寫入前用 AES-256-GCM 加密，金鑰來自本機 `.env` 的
  `ENCRYPTION_KEY`；讀取解密後只留在記憶體，不落地、不寫 log
- 提供讀取層給 Adapter Factory 和路由模組呼叫，例如：
  - `getCredential(id)` / `listEnabledCredentials()`
  - `getDeploymentByPublicModelName(name)` / `listDeployments()`
- 提供最陽春的 Web UI 表單，用來新增/編輯 Credential 與 Deployment——
  **已定案**採用此方式，不寫獨立 CLI，也不手動寫 SQL/seed。表單本身歸在
  `05-web-ui.md` 實作範圍，這裡只定義它要滿足的資料操作需求

## 已定案

- **新增/編輯設定的操作方式**：透過最陽春的 Web UI 表單完成（見
  `05-web-ui.md`）。表單至少要能：新增一筆 Credential、在其底下新增一筆
  以上 Deployment、編輯既有欄位、切換 `enabled`；不需要複雜的驗證流程或
  多步驟精靈
- **Model 名稱轉換（原「alias 對應」開放問題已解決）**：`model_deployments`
  的 `public_model_name` 就是 client 端看到的名稱，`provider_model_id` 是
  實際打給上游的名稱，兩者天然分離，不需要額外的 alias 對應表
- **api_key 不支援輪替**：v1 只需要「覆蓋更新」，不保留舊 key，不做過渡
  期雙 key 並存
- **健康檢查恢復排程，但改成 per-deployment 選擇性啟用**（2026-09-14
  修訂，原本規劃純手動）：雲端模型的 API 呼叫有成本，「每隔 N 分鐘自動打
  一次所有 provider」對個人版來說是不必要的開銷；但完全拿掉排程，等於
  「健康檢測（主動）＋Fallback（被動）雙重容錯」設計只剩一半。折衷方案：
  `auto_health_check_enabled` 預設 `false`，使用者自己選要排程哪些
  deployment——本地跑的 Ollama（免費）可以放心開著，貴的雲端 model 手動
  需要時再按。過程細節見 `docs/article-notes.md`
- **失敗通知走最簡單路線**：不做主動推播（email/Slack/系統通知），失敗
  請求照常寫進請求 log，Web UI 用警示色標示出來，使用者自己進去看

## 非目標（v1 不做）

- 多使用者權限管理
- Credential/Deployment 設定的版本歷史/稽核紀錄
- api_key 輪替（rotate）機制
- 排程間隔的 per-deployment 自訂（全域一個 `HEALTH_CHECK_INTERVAL_MINUTES`，
  不做「這筆 5 分鐘一次、那筆 1 小時一次」的細緻控制）
- 主動推播通知（email/Slack/系統通知）

## 開放問題（待確認）

無。
