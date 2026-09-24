-- 修正 0002_fancy_hulk.sql 的落差：`ALTER TABLE request_logs ADD api_key_id
-- ... REFERENCES api_keys(id)` 沒有把 schema.ts 宣告的 onDelete:'set null'
-- 生成進 SQL（drizzle-kit 對 ALTER TABLE ADD COLUMN 加外鍵時目前不會帶
-- ON DELETE 子句，跟 CREATE TABLE 時期生成的 deployment_id 外鍵不一致）。
-- SQLite 不支援直接改外鍵約束，只能整張表重建：新表結構跟現有欄位/型別
-- 完全一致，只是把兩個外鍵都補上 ON DELETE SET NULL 後照搬資料過去。
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`deployment_id` text,
	`api_key_id` text,
	`public_model_name` text NOT NULL,
	`provider_model_id` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`status_code` integer,
	`error_code` text,
	`error_message` text,
	`provider_error` text,
	`latency_ms` integer NOT NULL,
	`fallback_used` integer DEFAULT false NOT NULL,
	`fallback_attempts` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `model_deployments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_request_logs` (
	`id`, `request_id`, `deployment_id`, `api_key_id`, `public_model_name`, `provider_model_id`,
	`input_tokens`, `output_tokens`, `cost`, `status`, `status_code`, `error_code`, `error_message`,
	`provider_error`, `latency_ms`, `fallback_used`, `fallback_attempts`, `created_at`
)
SELECT
	`id`, `request_id`, `deployment_id`, `api_key_id`, `public_model_name`, `provider_model_id`,
	`input_tokens`, `output_tokens`, `cost`, `status`, `status_code`, `error_code`, `error_message`,
	`provider_error`, `latency_ms`, `fallback_used`, `fallback_attempts`, `created_at`
FROM `request_logs`;
--> statement-breakpoint
DROP TABLE `request_logs`;
--> statement-breakpoint
ALTER TABLE `__new_request_logs` RENAME TO `request_logs`;
--> statement-breakpoint
CREATE INDEX `request_logs_created_at_idx` ON `request_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX `request_logs_deployment_id_idx` ON `request_logs` (`deployment_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
