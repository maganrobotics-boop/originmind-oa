CREATE TABLE `auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`login_snapshot` text DEFAULT '' NOT NULL,
	`verified_email_snapshot` text DEFAULT '' NOT NULL,
	`linked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`unlinked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identities_provider_subject_unique` ON `auth_identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identities_member_provider_active_unique` ON `auth_identities` (`member_id`,`provider`) WHERE "auth_identities"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `auth_identities_member_active_idx` ON `auth_identities` (`member_id`,`unlinked_at`);--> statement-breakpoint
CREATE TABLE `oauth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`member_id` text,
	`login_snapshot` text DEFAULT '' NOT NULL,
	`email_snapshot` text NOT NULL,
	`display_name_snapshot` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `oauth_sessions_provider_subject_idx` ON `oauth_sessions` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE INDEX `oauth_sessions_member_idx` ON `oauth_sessions` (`member_id`);--> statement-breakpoint
CREATE INDEX `oauth_sessions_expires_idx` ON `oauth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_transactions` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`browser_nonce_hash` text NOT NULL,
	`pkce_verifier` text NOT NULL,
	`action` text NOT NULL,
	`member_id` text,
	`return_path` text DEFAULT '/' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `oauth_transactions_expires_idx` ON `oauth_transactions` (`expires_at`);