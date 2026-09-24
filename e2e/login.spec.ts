import { test, expect } from '@playwright/test';
import { login, SITE_PASSWORD } from './fixtures.js';

test('未登入直接訪問受保護頁面會被導回 /login', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL('/login');
});

test('密碼錯誤時顯示錯誤訊息，停留在登入頁', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('密碼').fill('wrong-password');
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page.getByText('密碼錯誤')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('密碼正確時登入成功，進入 Dashboard，且直接打後端 /admin/* 不帶 cookie 會被擋', async ({ page, request, baseURL }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: /Dashboard/ })).toBeVisible();

  // 06-site-auth.md 最重要的驗收項目：不能只擋 Next.js 頁面，直接繞過前端
  // 打後端 port 也要被擋下來。`request` fixture 是獨立的 context，不帶
  // `page` 登入後拿到的 cookie。
  const res = await request.get(`${baseURL}/admin/credentials`);
  // Next.js rewrites 這裡會把請求轉給後端，後端的 requireSiteSession 應該
  // 擋下沒有合法 cookie 的請求。
  expect(res.status()).toBe(401);
});

test('登出後 cookie 失效，重新訪問受保護頁面會再次被導回 /login', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '登出' }).click();
  await page.waitForURL('/login');

  await page.goto('/');
  await page.waitForURL('/login');
});

test('SITE_PASSWORD 常數本身有值（避免測試環境設定漏掉，其他測試靜默用空字串登入失敗卻誤判成別的錯誤）', () => {
  expect(SITE_PASSWORD.length).toBeGreaterThan(0);
});
