import { createApp } from './app.js';
import { startHealthCheckScheduler } from './health/scheduler.js';
import { startBudgetResetScheduler } from './billing/scheduler.js';

const app = createApp();

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`personal-llm-router admin API listening on http://localhost:${PORT}`);
});

// 排程獨立於 createApp() 之外啟動：createApp() 也被整合測試用來起 server，
// 測試不該意外背著一個真的 setInterval 跑。
startHealthCheckScheduler();
startBudgetResetScheduler();
