CREATE TABLE `external_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`destination` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`file_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`file_token` text,
	`lease_token` text,
	`lease_expires_at` text,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_archives_approval_destination_manifest_unique` ON `external_archives` (`approval_id`,`destination`,`manifest_hash`);--> statement-breakpoint
CREATE INDEX `external_archives_approval_destination_status_idx` ON `external_archives` (`approval_id`,`destination`,`status`);