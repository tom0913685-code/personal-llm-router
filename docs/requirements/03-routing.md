# 需求文件：請求路由/選路邏輯（含 Fallback）

## 目的

決定一個 chat 請求該送去哪個 Credential/Deployment，失敗時依序改送備援
Deployment，並把 client 端的 model 名稱翻譯成上游 provider 實際要求的名稱。

> **修訂說明（2026-09-10）**：因應 `01-config-management.md` 改用
> `credentials` + `model_deployments` 兩張表，路由邏輯從「查 provider 的
> `allowed_models` 陣列」改成「查 `model_deployments` 表」。
>
> **修訂說明（2026-09-14）**：**Fallback 從「v1 明確不做」改成「v1 就做」**。
> 原本的理由是 `public_model_name` 是單獨 UNIQUE 約束，結構性地排除了多
> 候選；跟 `main` 分支（另一個開發對話，NestJS+Prisma 平行實作）核對系列
> 文章大綱後，確認 Fallback 是「健康檢測（主動）＋Fallback（被動）雙重
> 容錯」設計的後半段，拿掉可惜，決定加回來。`model_deployments` 的
> `public_model_name` 改成跟 `priority` 的複合唯一索引，詳見
> `provider-adapter-spec.md` 與 `src/db/schema.ts`。過程細節見
> `docs/article-notes.md` 的「Fallback」主題。

## 功能需求

- 依 `request.model`（= `public_model_name`）查詢 `model_deployments`，篩選
  `enabled = true` 且所屬 `credential.enabled = true` 的列，**依 `priority`
  升冪排序**，得到一份候選清單（`resolveDeploymentCandidates()`，見
  `src/routing/resolve.ts`）
- 若候選清單為空，回傳明確錯誤（`"model not configured or disabled"`），
  由 Gateway 轉成 HTTP 404
- **依序嘗試候選清單**（見 `src/gateway/chat.routes.ts`）：
  1. 取一筆候選，用其 `credentialId` 查 `credentials` 表取得 Adapter 設定，
     透過 Adapter Factory 取得對應的 `ProviderAdapter` 實例
  2. 把 `UnifiedChatRequest.model` 換成該筆的 `provider_model_id`（而不是
     client 傳入的 `public_model_name`）後呼叫 `adapter.chat()`
  3. 成功就回傳結果，記錄用第幾筆候選（`fallback_attempts`）成功
  4. 失敗就記下這次失敗，繼續嘗試下一筆候選（中間失敗不寫 log，只有「最終
     結果」才寫一筆）
  5. 全部候選都失敗，回傳**最後一筆**候選的錯誤內容給 client（不是第一筆
     的——最後一筆失敗代表「所有備援都試過了」，對使用者診斷問題最有參考
     價值）
- **Adapter 實例做簡單的 in-memory cache**（cache key 為 `credential_id`，
  `src/routing/adapter-cache.ts`），避免每次請求都重新解密 `api_key` 建立
  新實例，Credential 設定變更時會呼叫 `invalidateAdapter()` 讓對應 cache
  失效
- `fallbackUsed` 判定：只要**不是**候選清單裡 priority 最小的那筆最終服務
  了這個請求（不論它自己成功，還是它失敗後換別筆成功），就算
  `fallbackUsed = true`

## 已定案

- Adapter 實例**維持快取**（cache key 為 credential_id），不是每次請求
  重新建立——這點跟參考另一個分支的規格（該分支選擇不快取）不同，維持
  這個分支原本的設計，因為 cache 本來就有 invalidation 機制保證正確性，
  沒有理由為了跟另一邊一致而拿掉一個已經驗證可行的效能優化
- Fallback 只在**呼叫當下**失敗才觸發，不參考 `model_deployments.health_status`
  來預先排除候選——`health_status` 是手動/排程健康檢查的結果，可能是舊
  資料，不該用來決定即時請求要不要嘗試某個 deployment；有問題呼叫當下
  自然會失敗，觸發 Fallback

## 非目標（v1 不做）

- 依成本、延遲動態選擇 deployment 的智慧路由——`priority` 是使用者手動
  排序，不是系統依即時指標算出來的
- 依 `health_status` 預先跳過候選（見上方「已定案」的說明）
- 依使用者/情境做的權限式路由（個人版沒有多使用者）
- 重試同一筆 deployment（失敗了就換下一筆候選，不對同一筆做
  retry-with-backoff）

## 開放問題（待確認）

無。
