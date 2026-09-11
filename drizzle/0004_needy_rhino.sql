CREATE TABLE `account_profiles` (
	`chatgpt_account` text PRIMARY KEY NOT NULL,
	`avatar_data_url` text DEFAULT '' NOT NULL,
	`profile_json` text DEFAULT '{}' NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_email` text NOT NULL,
	`sender_name` text NOT NULL,
	`recipient_email` text NOT NULL,
	`recipient_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
