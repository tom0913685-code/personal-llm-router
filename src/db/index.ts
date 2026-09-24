import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const DB_PATH = process.env.DB_PATH ?? './data/router.db';

const sqlite: InstanceType<typeof Database> = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL'); // 個人單機使用也值得開，讀寫不會互相鎖住，Docker volume 掛載下一樣有效
sqlite.pragma('foreign_keys = ON'); // SQLite 預設不強制外鍵約束，request_logs 的 ON DELETE SET NULL 要開這個才會生效

export const db = drizzle(sqlite, { schema });
export { schema, sqlite };
