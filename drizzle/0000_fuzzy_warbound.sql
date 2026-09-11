CREATE TABLE `approval_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`approval_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`project` text NOT NULL,
	`requester_name` text NOT NULL,
	`requester_email` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`status` text NOT NULL,
	`current_step` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`owner` text NOT NULL,
	`amount` text,
	`signers_json` text DEFAULT '[]' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL
);
