import type { Page } from '@playwright/test';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SITE_PASSWORD } from '../playwright.config.js';

export { SITE_PASSWORD };

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('密碼').fill(SITE_PASSWORD);
  await page.getByRole('button', { name: '登入' }).click();
  await page.waitForURL('/');
}

// 假上游：回一個固定的 OpenAI-shape chat completion，讓 golden path 測試
// 不依賴任何真實的第三方 provider（跟 health/scheduler.test.ts、
// chat.routes.test.ts 用 node:http 起假伺服器的既有慣例一致，只是這次是
// 給瀏覽器操作的 E2E 用，不是給 node:test 用）。
export interface FakeUpstream {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

export function startFakeUpstream(replyContent: string): Promise<FakeUpstream> {
  let requestCount = 0;
  const server = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
    requestCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: replyContent } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      }),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}/v1`,
        requestCount: () => requestCount,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
