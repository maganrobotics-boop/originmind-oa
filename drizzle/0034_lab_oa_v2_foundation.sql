CREATE TABLE `conversation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_member_id` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "conversation_events_action_check" CHECK("conversation_events"."action" IN ('created', 'renamed', 'member_added', 'member_removed', 'archived', 'restored'))
);
--> statement-breakpoint
CREATE INDEX `conversation_events_conversation_created_idx` ON `conversation_events` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`member_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`left_at` text,
	`last_read_message_id` text,
	`last_read_at` text,
	`added_by_member_id` text NOT NULL,
	CONSTRAINT "conversation_members_role_check" CHECK("conversation_members"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_members_active_unique` ON `conversation_members` (`conversation_id`,`member_id`) WHERE "conversation_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX `conversation_members_member_active_idx` ON `conversation_members` (`member_id`,`left_at`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_member_id` text NOT NULL,
	`sender_name` text NOT NULL,
	`body` text NOT NULL,
	`message_type` text DEFAULT 'text' NOT NULL,
	`reply_to_message_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`edited_at` text,
	`deleted_at` text,
	CONSTRAINT "conversation_messages_body_check" CHECK(length("conversation_messages"."body") BETWEEN 1 AND 16000),
	CONSTRAINT "conversation_messages_type_check" CHECK("conversation_messages"."message_type" IN ('text', 'system', 'file'))
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation_created_idx` ON `conversation_messages` (`conversation_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_sender_created_idx` ON `conversation_messages` (`sender_member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`direct_key` text,
	`project_id` text,
	`created_by_member_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`archived_at` text,
	CONSTRAINT "conversations_type_check" CHECK("conversations"."type" IN ('direct', 'group', 'project', 'ai')),
	CONSTRAINT "conversations_direct_key_check" CHECK(("conversations"."type" = 'direct' AND "conversations"."direct_key" IS NOT NULL) OR ("conversations"."type" <> 'direct' AND "conversations"."direct_key" IS NULL)),
	CONSTRAINT "conversations_project_check" CHECK(("conversations"."type" = 'project' AND "conversations"."project_id" IS NOT NULL) OR "conversations"."type" <> 'project')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_direct_key_unique` ON `conversations` (`direct_key`) WHERE "conversations"."direct_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_project_updated_idx` ON `conversations` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `department_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`department_id` text NOT NULL,
	`member_id` text NOT NULL,
	`membership_type` text DEFAULT 'primary' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`left_at` text,
	`created_by_member_id` text NOT NULL,
	CONSTRAINT "department_memberships_type_check" CHECK("department_memberships"."membership_type" IN ('primary', 'collaborator'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `department_memberships_active_unique` ON `department_memberships` (`department_id`,`member_id`) WHERE "department_memberships"."left_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `department_memberships_member_primary_unique` ON `department_memberships` (`member_id`) WHERE "department_memberships"."left_at" IS NULL AND "department_memberships"."membership_type" = 'primary';--> statement-breakpoint
CREATE INDEX `department_memberships_member_active_idx` ON `department_memberships` (`member_id`,`left_at`);--> statement-breakpoint
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "departments_code_check" CHECK(length(trim("departments"."code")) BETWEEN 1 AND 64),
	CONSTRAINT "departments_name_check" CHECK(length(trim("departments"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "departments_status_check" CHECK("departments"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `departments_code_unique` ON `departments` (`code`);--> statement-breakpoint
CREATE INDEX `departments_parent_sort_idx` ON `departments` (`parent_id`,`sort_order`,`name`);--> statement-breakpoint
CREATE TABLE `project_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`linked_by_member_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "project_links_type_check" CHECK("project_links"."resource_type" IN ('approval', 'knowledge', 'meeting', 'work_item', 'conversation', 'email'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_links_resource_unique` ON `project_links` (`project_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `project_links_resource_idx` ON `project_links` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`member_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`left_at` text,
	`added_by_member_id` text NOT NULL,
	CONSTRAINT "project_members_role_check" CHECK("project_members"."role" IN ('owner', 'manager', 'member', 'observer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_members_active_unique` ON `project_members` (`project_id`,`member_id`) WHERE "project_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX `project_members_member_active_idx` ON `project_members` (`member_id`,`left_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`owner_member_id` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`archived_at` text,
	CONSTRAINT "projects_key_check" CHECK(length(trim("projects"."project_key")) BETWEEN 1 AND 80),
	CONSTRAINT "projects_name_check" CHECK(length(trim("projects"."name")) BETWEEN 1 AND 160),
	CONSTRAINT "projects_status_check" CHECK("projects"."status" IN ('planned', 'active', 'paused', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_key_unique` ON `projects` (`project_key`);--> statement-breakpoint
CREATE INDEX `projects_status_updated_idx` ON `projects` (`status`,`updated_at`);--> statement-breakpoint
INSERT INTO `departments` (`id`,`code`,`name`,`parent_id`,`status`,`sort_order`,`created_by_member_id`)
VALUES
  ('department:agent_hardware','agent_hardware','Agent Hardware',NULL,'active',10,'migration:0034'),
  ('department:agent_os','agent_os','Agent OS',NULL,'active',20,'migration:0034'),
  ('department:agent_application','agent_application','Agent Application',NULL,'active',30,'migration:0034');--> statement-breakpoint
INSERT INTO `department_memberships` (`id`,`department_id`,`member_id`,`membership_type`,`title`,`created_by_member_id`)
SELECT 'legacy-primary:' || `id`,'department:' || `department_code`,`id`,'primary','', 'migration:0034'
FROM `members`
WHERE `department_code` IN ('agent_hardware','agent_os','agent_application');--> statement-breakpoint
CREATE TRIGGER `conversation_events_migration_freeze_insert` BEFORE INSERT ON `conversation_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_events_migration_freeze_update` BEFORE UPDATE ON `conversation_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_events_migration_freeze_delete` BEFORE DELETE ON `conversation_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_migration_freeze_insert` BEFORE INSERT ON `conversation_members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_migration_freeze_update` BEFORE UPDATE ON `conversation_members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_migration_freeze_delete` BEFORE DELETE ON `conversation_members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_migration_freeze_insert` BEFORE INSERT ON `conversation_messages` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_migration_freeze_update` BEFORE UPDATE ON `conversation_messages` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_migration_freeze_delete` BEFORE DELETE ON `conversation_messages` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversations_migration_freeze_insert` BEFORE INSERT ON `conversations` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversations_migration_freeze_update` BEFORE UPDATE ON `conversations` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `conversations_migration_freeze_delete` BEFORE DELETE ON `conversations` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `department_memberships_migration_freeze_insert` BEFORE INSERT ON `department_memberships` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `department_memberships_migration_freeze_update` BEFORE UPDATE ON `department_memberships` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `department_memberships_migration_freeze_delete` BEFORE DELETE ON `department_memberships` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `departments_migration_freeze_insert` BEFORE INSERT ON `departments` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `departments_migration_freeze_update` BEFORE UPDATE ON `departments` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `departments_migration_freeze_delete` BEFORE DELETE ON `departments` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `project_links_migration_freeze_insert` BEFORE INSERT ON `project_links` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `project_links_migration_freeze_update` BEFORE UPDATE ON `project_links` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `project_links_migration_freeze_delete` BEFORE DELETE ON `project_links` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `project_members_migration_freeze_insert` BEFORE INSERT ON `project_members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `project_members_migration_freeze_update` BEFORE UPDATE ON `project_members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `project_members_migration_freeze_delete` BEFORE DELETE ON `project_members` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `projects_migration_freeze_insert` BEFORE INSERT ON `projects` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `projects_migration_freeze_update` BEFORE UPDATE ON `projects` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;--> statement-breakpoint
CREATE TRIGGER `projects_migration_freeze_delete` BEFORE DELETE ON `projects` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
