CREATE TABLE `migration_control` (
	`freeze_id` text PRIMARY KEY NOT NULL,
	`activated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deactivated_at` text
);
--> statement-breakpoint
CREATE TRIGGER `approvals_migration_freeze_insert` BEFORE INSERT ON `approvals` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approvals_migration_freeze_update` BEFORE UPDATE ON `approvals` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approvals_migration_freeze_delete` BEFORE DELETE ON `approvals` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_events_migration_freeze_insert` BEFORE INSERT ON `approval_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_events_migration_freeze_update` BEFORE UPDATE ON `approval_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_events_migration_freeze_delete` BEFORE DELETE ON `approval_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_revisions_migration_freeze_insert` BEFORE INSERT ON `approval_revisions` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_revisions_migration_freeze_update` BEFORE UPDATE ON `approval_revisions` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_revisions_migration_freeze_delete` BEFORE DELETE ON `approval_revisions` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `labor_source_claims_migration_freeze_insert` BEFORE INSERT ON `labor_source_claims` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `labor_source_claims_migration_freeze_update` BEFORE UPDATE ON `labor_source_claims` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `labor_source_claims_migration_freeze_delete` BEFORE DELETE ON `labor_source_claims` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `external_archives_migration_freeze_insert` BEFORE INSERT ON `external_archives` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `external_archives_migration_freeze_update` BEFORE UPDATE ON `external_archives` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `external_archives_migration_freeze_delete` BEFORE DELETE ON `external_archives` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `members_migration_freeze_insert` BEFORE INSERT ON `members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `members_migration_freeze_update` BEFORE UPDATE ON `members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `members_migration_freeze_delete` BEFORE DELETE ON `members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `member_events_migration_freeze_insert` BEFORE INSERT ON `member_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `member_events_migration_freeze_update` BEFORE UPDATE ON `member_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `member_events_migration_freeze_delete` BEFORE DELETE ON `member_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_migration_freeze_insert` BEFORE INSERT ON `auth_identities` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_migration_freeze_update` BEFORE UPDATE ON `auth_identities` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_migration_freeze_delete` BEFORE DELETE ON `auth_identities` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `account_profiles_migration_freeze_insert` BEFORE INSERT ON `account_profiles` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `account_profiles_migration_freeze_update` BEFORE UPDATE ON `account_profiles` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `account_profiles_migration_freeze_delete` BEFORE DELETE ON `account_profiles` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `direct_messages_migration_freeze_insert` BEFORE INSERT ON `direct_messages` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `direct_messages_migration_freeze_update` BEFORE UPDATE ON `direct_messages` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `direct_messages_migration_freeze_delete` BEFORE DELETE ON `direct_messages` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
