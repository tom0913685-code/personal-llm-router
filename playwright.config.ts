import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// @article topic:e2e-tests
// 之前每次要驗證前後端整合行為，都是臨時裝 playwright-core 寫一支腳本、
// 跑完就刪，完全沒有留下可重複執行的東西——開源後外部貢獻者沒有這些「只
// 存在於某次對話裡」的驗證過程可以參考。這份設定把同樣的手法固定下來，
// 變成 `npm run test:e2e` 就能重跑的持久化測試。
//
// 完全隔離的測試環境，不動到使用者本機開發用的 data/router.db／真實
// SITE_PASSWORD：獨立的 port、獨立的 SQLite 檔案（系統暫存目錄，跑完即
// 丟）、當場產生的隨機密鑰，不依賴、也不污染 repo 裡任何一份 .env。
export const BACKEND_PORT = 8799;
const FRONTEND_PORT = 3099;

export const E2E_DB_PATH = path.join(os.tmpdir(), `personal-llm-router-e2e-${Date.now()}-${process.pid}.db`);
const DB_PATH = E2E_DB_PATH;
const ENCRYPTION_KEY = randomBytes(32).toString('hex');
const SITE_SESSION_SECRET = randomBytes(32).toString('hex');
export const SITE_PASSWORD = 'e2e-test-password';

const BACKEND_ENV = {
  PORT: String(BACKEND_PORT),
  DB_PATH,
  ENCRYPTION_KEY,
  SITE_SESSION_SECRET,
  // health/budget 排程用不到、也不該在測試run裡跑背景 setInterval 干擾計時，
  // 但兩個排程本來就只在 src/server.ts 啟動（不是 createApp()），E2E 打的是
  // 真的 dist/server.js，會啟動——設一個超長的間隔，測試執行時間內不會被
  // 排程意外碰到 DB。上限是 Node setInterval 的 32-bit 訊號整數毫秒數
  // （約 24.8 天，2147483647ms），超過會被 Node 直接 clamp 成 1ms、瘋狂
  // 連續觸發，反而變成最短而不是最長間隔——35000 分鐘（約 24.3 天）是安
  // 全上限內最接近「這次測試執行期間不會觸發」的值。
  HEALTH_CHECK_INTERVAL_MINUTES: '35000',
  BUDGET_RESET_SCAN_INTERVAL_MINUTES: '35000',
};

const FRONTEND_ENV = {
  PORT: String(FRONTEND_PORT),
  BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
  SITE_SESSION_SECRET,
  SITE_PASSWORD,
};

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 30_000,
  // 多個測試檔共用同一組後端/DB 狀態（例如 Credential 建立在前一個測試
  // 留下的資料上），跟現有後端整合測試「各自獨立 in-memory DB」的模式不
  // 同——這裡刻意選擇貼近真實使用情境（一個人持續操作同一個 Web UI），
  // 用 workers:1 保證測試依序執行、不會因為平行跑而互相干擾同一份 DB。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // 用真的 build 產物跑（不是 tsx/ts-node 直接跑原始碼）——E2E 的目的
      // 之一就是驗證「照 README 建置流程走真的能動」，不是驗證原始碼邏輯
      // （那是 node:test 單元/整合測試的責任）。不用 npm run start（那支
      // script 帶 --env-file=.env，會去讀開發者本機的真實密鑰跟 DB 設定）。
      command: 'npm run build && npm run db:migrate && node dist/server.js',
      url: `http://localhost:${BACKEND_PORT}/healthz`,
      env: BACKEND_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run build && npm run start -- -p ' + FRONTEND_PORT,
      cwd: './frontend',
      url: `http://localhost:${FRONTEND_PORT}/login`,
      env: FRONTEND_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  // channel: 'msedge' 重用系統既有安裝的 Edge，跟這個專案一路以來的
  // Playwright 手動驗證方式一致，不用另外 `npx playwright install` 下載
  // Chromium——對開源後的貢獻者來說，Windows 機器上幾乎必定已經有 Edge。
  projects: [{ name: 'e2e', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
});
