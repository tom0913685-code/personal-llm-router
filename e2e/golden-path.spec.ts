import { test, expect } from '@playwright/test';
import { login, startFakeUpstream } from './fixtures.js';
import { BACKEND_PORT } from '../playwright.config.js';

// @article topic:e2e-tests
// 這條路徑涵蓋整個專案的核心價值鏈：Web UI 設定 → Gateway 真的能用 →
// 使用有落地到 Logs。用假上游（node:http，見 fixtures.ts）取代真實
// provider，讓測試不依賴任何外部服務、也不會產生真實費用。
test('golden path：登入 → 建 Credential → 建 Deployment → 建 API Key → 呼叫 Gateway → Logs 出現紀錄', async ({ page, request }) => {
  const upstream = await startFakeUpstream('pong from e2e fake upstream');
  const suffix = Date.now();
  const credentialName = `e2e-cred-${suffix}`;
  const modelName = `e2e-model-${suffix}`;
  let apiKeyPlaintext = '';

  try {
    await test.step('登入', async () => {
      await login(page);
    });

    await test.step('新增 Credential，baseUrl 指向假上游', async () => {
      await page.goto('/models');
      await page.getByRole('tab', { name: 'Credentials' }).click();
      await page.getByRole('button', { name: '+ 新增 Credential' }).click();
      await page.getByLabel('名稱').fill(credentialName);
      await page.getByLabel('Base URL').fill(upstream.url);
      await page.getByLabel('API Key').fill('sk-e2e-fake-upstream-key');
      await page.getByRole('button', { name: '儲存' }).click();
      await expect(page.getByRole('cell', { name: credentialName })).toBeVisible();
    });

    await test.step('新增 Deployment，建立當下自動跑一次深層健康檢查，應該回 healthy', async () => {
      await page.getByRole('tab', { name: 'Deployments' }).click();
      await page.getByRole('button', { name: '+ 新增 Deployment' }).click();
      await page.getByLabel('所屬 Credential').selectOption({ label: credentialName });
      // Priority 欄位的說明文字裡也含有「Public Model Name」字樣（"同一個
      // Public Model Name 底下不能重複"），regex 要錨定開頭才不會兩個都命中。
      await page.getByLabel(/^Public Model Name/).fill(modelName);
      await page.getByLabel(/^Provider Model ID/).fill('e2e-provider-model');
      await page.getByRole('button', { name: '儲存' }).click();

      const row = page.locator('tr', { hasText: modelName });
      await expect(row).toBeVisible();
      // HealthBadge 的徽章跟 hover tooltip 裡都含「數字+ms」字樣，用開頭的
      // ● 符號鎖定只比對徽章本身，避免 strict mode 同時命中兩個元素。
      await expect(row.getByText(/●\s*\d+ms/)).toBeVisible({ timeout: 15_000 });
    });

    await test.step('新增 API Key，取得明文', async () => {
      await page.goto('/api-keys');
      await page.getByRole('button', { name: '+ 新增 API Key' }).click();
      await page.getByLabel('名稱').fill('e2e-key');
      await page.getByRole('button', { name: '儲存' }).click();

      // 清單畫面的 key_prefix 也是用 <code> 顯示，明確只找彈出視窗裡的那個
      // 完整明文，不要跟清單裡截斷的前綴搞混。
      const codeBlock = page.getByRole('dialog').locator('code');
      await expect(codeBlock).toBeVisible();
      apiKeyPlaintext = (await codeBlock.textContent())?.trim() ?? '';
      expect(apiKeyPlaintext).toMatch(/^sk-/);

      await page.getByRole('button', { name: '我已複製，關閉' }).click();
    });

    await test.step('用這把 key 直接打 Gateway /v1/chat/completions（不經過 Web UI）', async () => {
      const res = await request.post(`http://localhost:${BACKEND_PORT}/v1/chat/completions`, {
        headers: { Authorization: `Bearer ${apiKeyPlaintext}` },
        data: { model: modelName, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe('pong from e2e fake upstream');
    });

    await test.step('Logs 頁面出現這筆請求', async () => {
      await page.goto('/logs');
      await expect(page.getByRole('cell', { name: modelName })).toBeVisible();
    });
  } finally {
    await upstream.close();
  }
});
