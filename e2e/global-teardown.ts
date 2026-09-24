import fs from 'node:fs';
import { E2E_DB_PATH } from '../playwright.config.js';

// WAL 模式（src/db/index.ts 開了 journal_mode = WAL）會在主檔案旁邊產生
// -wal/-shm 兩個附屬檔案。這裡只是盡力清一次——Windows 上 backend
// process 實際釋放檔案控制代碼的時間點跟 Playwright 呼叫這支 teardown
// 沒有保證的先後關係，有時候會晚到测試指令本身都已經印出結果才真的放
// 開，重試等待不划算。刪不掉就留給系統暫存目錄自己回收，不影響測試結果。
export default function globalTeardown(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${E2E_DB_PATH}${suffix}`);
    } catch {
      // 忽略：檔案不存在，或還被 backend process 占用（過一陣子系統暫存目錄
      // 自己會清）。
    }
  }
}
