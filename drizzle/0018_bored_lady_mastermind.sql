CREATE TABLE `write_rate_buckets` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`actor_subject` text NOT NULL,
	`scope` text NOT NULL,
	`window_started_at` text NOT NULL,
	`used` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `write_rate_buckets_updated_idx` ON `write_rate_buckets` (`updated_at`);