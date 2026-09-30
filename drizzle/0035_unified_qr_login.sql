CREATE TABLE `qr_login_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`browser_nonce_hash` text NOT NULL,
	`action` text NOT NULL,
	`link_member_id` text,
	`link_account_user_id` text,
	`link_member_revision` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text,
	`provider_subject` text,
	`login_snapshot` text,
	`display_name_snapshot` text,
	`member_id` text,
	`scanner_nonce_hash` text,
	`verification_code` text NOT NULL,
	`desktop_label` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`receipt_hash` text,
	`denial_reason` text,
	CONSTRAINT "qr_login_action_check" CHECK("qr_login_challenges"."action" IN ('login', 'link')),
	CONSTRAINT "qr_login_status_check" CHECK("qr_login_challenges"."status" IN ('pending', 'verified', 'approved', 'consumed', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `qr_login_challenges_browser_idx` ON `qr_login_challenges` (`browser_nonce_hash`);--> statement-breakpoint
CREATE INDEX `qr_login_challenges_expires_idx` ON `qr_login_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `qr_oauth_attempts` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`challenge_id` text NOT NULL,
	`provider` text NOT NULL,
	`scanner_nonce_hash` text NOT NULL,
	`pkce_verifier` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`failure_reason` text,
	FOREIGN KEY (`challenge_id`) REFERENCES `qr_login_challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "qr_oauth_provider_check" CHECK("qr_oauth_attempts"."provider" IN ('feishu', 'wecom'))
);
--> statement-breakpoint
CREATE INDEX `qr_oauth_attempts_challenge_idx` ON `qr_oauth_attempts` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `qr_oauth_attempts_expires_idx` ON `qr_oauth_attempts` (`expires_at`);