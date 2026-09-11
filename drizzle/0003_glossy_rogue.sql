ALTER TABLE `approvals` ADD `current_reviewer_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `current_reviewer_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `permissions_json` text DEFAULT '[]' NOT NULL;