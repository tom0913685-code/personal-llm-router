import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './db/index.js';

// Docker 部署用的啟動期遷移：跑在一個全新掛載的 volume 上，data/router.db
// 一開始沒有任何表格，要先套用 drizzle/ 底下的 migration 才能起服務。用
// drizzle-orm 內建的 migrate()，不依賴 drizzle-kit（那是 devDependency，
// 不會裝進 production image，體積也小很多）。
migrate(db, { migrationsFolder: './drizzle' });
sqlite.close();
console.log('Migrations applied');
