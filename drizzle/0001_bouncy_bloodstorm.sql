DROP INDEX `model_deployments_public_model_name_unique`;--> statement-breakpoint
ALTER TABLE `model_deployments` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_deployments` ADD `auto_health_check_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `model_deployments_public_model_name_priority_idx` ON `model_deployments` (`public_model_name`,`priority`);--> statement-breakpoint
CREATE INDEX `model_deployments_public_model_name_idx` ON `model_deployments` (`public_model_name`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `fallback_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `fallback_attempts` integer DEFAULT 1 NOT NULL;