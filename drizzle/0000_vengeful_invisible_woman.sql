CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter_type` text NOT NULL,
	`base_url` text,
	`api_key_encrypted` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_name_unique` ON `credentials` (`name`);--> statement-breakpoint
CREATE TABLE `model_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`public_model_name` text NOT NULL,
	`provider_model_id` text NOT NULL,
	`input_cost_per_million` real DEFAULT 0 NOT NULL,
	`output_cost_per_million` real DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`last_checked_at` text,
	`last_latency_ms` integer,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_deployments_public_model_name_unique` ON `model_deployments` (`public_model_name`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`deployment_id` text,
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
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `model_deployments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `request_logs_created_at_idx` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_deployment_id_idx` ON `request_logs` (`deployment_id`);