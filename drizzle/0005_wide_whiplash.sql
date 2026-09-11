PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_members` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`identity_number` text,
	`school_email` text DEFAULT '' NOT NULL,
	`chatgpt_account` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`permissions_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_members`("id", "full_name", "identity_number", "school_email", "chatgpt_account", "role", "permissions_json", "status", "created_at", "last_seen_at") SELECT "id", "full_name", "identity_number", "school_email", "chatgpt_account", "role", "permissions_json", "status", "created_at", "last_seen_at" FROM `members`;--> statement-breakpoint
DROP TABLE `members`;--> statement-breakpoint
ALTER TABLE `__new_members` RENAME TO `members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `members_identity_number_unique` ON `members` (`identity_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_chatgpt_account_unique` ON `members` (`chatgpt_account`);