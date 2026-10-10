CREATE TABLE `wecom_bot_links` (
	`bot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`member_id` text NOT NULL,
	`account_user_id` text NOT NULL,
	`linked_member_revision` text NOT NULL,
	`revision` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text,
	PRIMARY KEY(`bot_id`, `user_id`),
	CONSTRAINT "wecom_bot_links_bot_id_check" CHECK(length("wecom_bot_links"."bot_id") BETWEEN 1 AND 128),
	CONSTRAINT "wecom_bot_links_user_id_check" CHECK(length("wecom_bot_links"."user_id") BETWEEN 1 AND 128),
	CONSTRAINT "wecom_bot_links_identity_check" CHECK(length("wecom_bot_links"."member_id") > 0 AND length("wecom_bot_links"."account_user_id") > 0 AND length("wecom_bot_links"."revision") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wecom_bot_links_active_member_unique` ON `wecom_bot_links` (`bot_id`,`member_id`) WHERE "wecom_bot_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `wecom_bot_messages` (
	`bot_id` text NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`bot_id`, `message_id`),
	CONSTRAINT "wecom_bot_messages_identity_check" CHECK(length("wecom_bot_messages"."bot_id") BETWEEN 1 AND 128 AND length("wecom_bot_messages"."message_id") BETWEEN 1 AND 128 AND length("wecom_bot_messages"."user_id") BETWEEN 1 AND 128),
	CONSTRAINT "wecom_bot_messages_expiry_check" CHECK("wecom_bot_messages"."expires_at" > "wecom_bot_messages"."created_at")
);
--> statement-breakpoint
CREATE INDEX `wecom_bot_messages_expiry_idx` ON `wecom_bot_messages` (`expires_at`);--> statement-breakpoint
CREATE INDEX `wecom_bot_messages_rate_idx` ON `wecom_bot_messages` (`bot_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wecom_bot_messages_bot_rate_idx` ON `wecom_bot_messages` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `wecom_bot_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`member_id` text NOT NULL,
	`account_user_id` text NOT NULL,
	`member_revision` text NOT NULL,
	`member_nda_approval_id` text,
	`member_nda_accepted_at` text,
	`member_nda_agreement_version` text,
	`member_is_admin` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`candidate_user_id` text,
	`link_revision` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "wecom_bot_pairings_admin_check" CHECK("wecom_bot_pairings"."member_is_admin" IN (0, 1)),
	CONSTRAINT "wecom_bot_pairings_state_check" CHECK("wecom_bot_pairings"."state" IN ('pending', 'candidate', 'confirmed', 'cancelled')),
	CONSTRAINT "wecom_bot_pairings_code_hash_check" CHECK(length("wecom_bot_pairings"."code_hash") = 64 AND "wecom_bot_pairings"."code_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "wecom_bot_pairings_expiry_check" CHECK("wecom_bot_pairings"."expires_at" > "wecom_bot_pairings"."created_at"),
	CONSTRAINT "wecom_bot_pairings_pending_check" CHECK(("wecom_bot_pairings"."state" = 'pending' AND "wecom_bot_pairings"."candidate_user_id" IS NULL) OR "wecom_bot_pairings"."state" <> 'pending'),
	CONSTRAINT "wecom_bot_pairings_candidate_check" CHECK("wecom_bot_pairings"."state" NOT IN ('candidate', 'confirmed') OR length("wecom_bot_pairings"."candidate_user_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wecom_bot_pairings_code_hash_unique` ON `wecom_bot_pairings` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `wecom_bot_pairings_active_member_unique` ON `wecom_bot_pairings` (`bot_id`,`member_id`) WHERE "wecom_bot_pairings"."state" IN ('pending', 'candidate');--> statement-breakpoint
CREATE INDEX `wecom_bot_pairings_expiry_idx` ON `wecom_bot_pairings` (`expires_at`);