ALTER TABLE `credentials` ADD `connectivity_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `credentials` ADD `last_checked_at` text;--> statement-breakpoint
ALTER TABLE `credentials` ADD `last_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `credentials` ADD `last_error` text;