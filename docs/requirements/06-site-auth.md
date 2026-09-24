# 需求文件：Web UI 網站密碼保護

## 目的

**2026-09-19 修訂**：`ROUTER_API_KEY` 整個拿掉了（見 `08-api-key-layer.md`），
原本靠它保護的 `/admin/*` 現在需要新的守門機制——這份文件的登入密碼**升
格成 `/admin/*` 唯一的身分驗證**，不再只是「進站前多加一道關卡」。

順帶解決的舊問題：原本前端把 `ROUTER_API_KEY` 直接嵌進 JS bundle
（`NEXT_PUBLIC_ROUTER_API_KEY`），只要瀏覽器能載入網站就能在開發者工具
看到這把 key，等於「看得到網頁＝拿得到管理權限」。改成登入密碼＋
session 之後，沒有密碼連畫面都進不去，也沒有任何管理用的固定 key 需要
嵌進前端 bundle。

## 範圍（已定案，2026-09-19 修訂）

- **保護 Web UI 頁面本身（Next.js 路由）跟 `/admin/*`（Express 後端
  API）兩層**——這是跟原始版本最大的差異：原本假設 `/admin/*` 會繼續有
  `ROUTER_API_KEY` 擋著，只要擋 Next.js 頁面就夠了；現在 `ROUTER_API_KEY`
  沒了，如果只擋頁面、不擋 `/admin/*` 本身，任何人知道後端 port（例如
  `8787`）就能直接打 `/admin/*` 完全繞過登入密碼。所以 Express 後端也要
  能獨立驗證同一個 session（不能只靠「請求是從 Next.js 頁面發出的」這種
  假設）
- **`/v1/*`（Gateway）不受這份文件影響**，改用 `08-api-key-layer.md` 的
  API Key 層，跟登入密碼是兩套獨立機制——Cursor/Claude Code 等工具呼叫
  `/v1/*` 的方式不會变成要先登入
- 這不是「使用者帳號登入系統」（呼應 `05-web-ui.md` 原本的非目標）——**只
  有一組共用密碼，沒有帳號/使用者概念**，跟這個專案「個人單機使用」的定
  位一致

## 功能需求

- **登入頁**（例如 `/login`）：一個密碼輸入框 + 送出按鈕，密碼錯誤時顯示
  「密碼錯誤」，不用區分「帳號不存在」之類的訊息（本來就沒有帳號概念）
- **Next.js Middleware** 擋所有頁面路由：沒有有效的 session cookie 就導去
  `/login`；`/login` 本身、Next.js 靜態資源（`_next/*`）、favicon 不擋
- **Session cookie**：登入成功後發一個 HttpOnly cookie，帶簽章（HMAC）跟
  過期時間，Middleware 檢查時驗證簽章＋是否過期，**不落地存 session 到
  DB**（跟這個專案的 API Key 加密方案一樣，走無狀態驗證，不為了 session
  這件事另外開一張表）
- **登出按鈕**：清掉 session cookie，導回 `/login`
- 密碼存在環境變數（例如 `SITE_PASSWORD`），跟 `ENCRYPTION_KEY` 一樣的存
  放方式（`.env`，明文，本機檔案不外流）
- 密碼比對用 constant-time 比較（沿用 `src/auth/require-api-key.ts` 原本
  比 `ROUTER_API_KEY` 用的 `timingSafeStringEqual()` 手法——那個檔案本身
  因為 `ROUTER_API_KEY` 拿掉會被移除/改用途，但這個比較手法要保留下來，
  不要重新寫一份會漏掉 constant-time 這個細節的版本）
- **Express 後端也要能獨立驗證 session**：`src/app.ts` 掛在 `/admin/*`
  前面的 middleware，改成驗證登入時發的那個 session cookie（HMAC 簽章＋
  過期時間），不是重新發明一套——跟 Next.js Middleware 驗證的是同一顆
  cookie、同一個 `SITE_SESSION_SECRET`，只是分別在兩個 process（Next.js
  跟 Express）裡各自實作一份驗證邏輯。瀏覽器打 `/admin/*` 時走的是
  Next.js 的 `rewrites()`（同源相對路徑請求，cookie 會自動帶上），Express
  這層驗證是「即使有人跳過 Next.js 直接打後端 port」的最後一道防線，不
  是多餘的重複檢查

## 已定案

- **驗證方式：自製登入頁 + session cookie**，不用 HTTP Basic Auth——體驗
  比瀏覽器原生跳窗好（有登出按鈕、可以做過期時間），成本增加有限
- **Session cookie 過期時間：7 天**，過期後回登入頁重新輸入密碼；沒有
  「記住我」/「維持登入」等分級選項，只有一種過期時間
- **Cookie 屬性**：`HttpOnly`（JS 讀不到，防 XSS 竊取）、`SameSite=Lax`
  （個人單機使用不需要跨站請求，Lax 夠用）、`Secure` 只在偵測到
  HTTPS/生產環境時加上（本機用 HTTP 開發時 `Secure` cookie 瀏覽器不會送，
  要能兼顧本機開發跟未來可能的正式部署）
- **簽章金鑰**：新增一個環境變數（例如 `SITE_SESSION_SECRET`）專門給
  session cookie 簽章用，不重複使用 `ENCRYPTION_KEY`——兩者用途不同（一個
  是加密 API key 存進 DB，一個是簽章 session token），混用會讓「這個金鑰
  是為了什麼」變得含糊
- **暴力破解防護：v1 不做**（見下方非目標）——個人單機使用，攻擊面主要
  是網址外流，不是對外公開被暴力嘗試
- **實作位置**：
  - Next.js 側：Middleware（實際檔案是 `frontend/src/proxy.ts`——Next.js 16
    把原本的 `middleware.ts` 慣例標記成 deprecated，改用 `proxy.ts`，見
    `docs/auth-migration-plan.md` Phase 1 的實作筆記）擋頁面路由 +
    一個 Route Handler 處理登入表單送出（例如
    `frontend/src/app/api/login/route.ts`）；簽章/驗證邏輯用 Web Crypto
    API（`crypto.subtle`），因為 Next.js Middleware 預設在 Edge Runtime
    執行，不保證有完整的 `node:crypto` 可用
  - Express 側：新的 middleware 掛在 `/admin/*` 前面（取代原本的
    `requireApiKey`），驗證同一顆 session cookie——Node.js 18+ 全域也有
    `crypto.subtle`（Web Crypto API），兩側可以用同一套演算法/程式邏輯，
    不用為了 runtime 差異寫兩份不同的驗證方式

## 非目標（v1 不做）

- 多組帳號/使用者概念（呼應「個人單機使用」的定位，沿用只有一組共用密碼）
- 暴力破解防護（rate limiting、失敗次數鎖定）
- 密碼修改功能（改密碼＝改 `.env` 的 `SITE_SESSION_SECRET`/`SITE_PASSWORD`
  後重啟 process）
- Session 撤銷機制（例如「登出所有裝置」）——沒有伺服器端 session 儲存，
  沒有可以撤銷的目標；真的要撤銷就是換掉 `SITE_SESSION_SECRET`，所有現存
  cookie 一次失效
- 保護 `/v1/*` 本身（改用 `08-api-key-layer.md` 的 API Key 層，見上方範圍）

## 開放問題（待確認）

無。
