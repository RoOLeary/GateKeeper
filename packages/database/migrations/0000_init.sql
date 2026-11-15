CREATE TABLE `agent_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_messages_session_idx` ON `agent_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`requested_args` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`requester_id` text NOT NULL,
	`status` text NOT NULL,
	`approver_id` text,
	`decision_reason` text,
	`idempotency_key` text NOT NULL,
	`resource_version_at_request` integer NOT NULL,
	`correlation_id` text,
	`result_refund_id` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	`executed_at` text,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_requester_idempotency_uq` ON `approval_requests` (`requester_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `approval_status_idx` ON `approval_requests` (`status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`actor_id` text,
	`actor_role` text,
	`action` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`decision` text NOT NULL,
	`reason` text,
	`correlation_id` text NOT NULL,
	`channel` text NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `audit_correlation_idx` ON `audit_events` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `audit_resource_idx` ON `audit_events` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`assigned_rep_id` text NOT NULL,
	`account_status` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assigned_rep_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `customers_rep_idx` ON `customers` (`assigned_rep_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY NOT NULL,
	`customer_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`requested_by` text NOT NULL,
	`approved_by` text NOT NULL,
	`approval_request_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_approval_request_id_unique` ON `refunds` (`approval_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_idempotency_key_unique` ON `refunds` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `trace_events` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`correlation_id` text NOT NULL,
	`session_id` text,
	`actor_id` text,
	`type` text NOT NULL,
	`name` text,
	`outcome` text NOT NULL,
	`duration_ms` integer,
	`attributes` text
);
--> statement-breakpoint
CREATE INDEX `trace_correlation_idx` ON `trace_events` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`team_id` text,
	`refund_approval_limit_cents` integer
);
