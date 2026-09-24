CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`allowed_models` text,
	`budget_limit` real,
	`current_spend` real DEFAULT 0 NOT NULL,
	`budget_reset_day` integer,
	`last_reset_at` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `api_key_id` text REFERENCES api_keys(id);