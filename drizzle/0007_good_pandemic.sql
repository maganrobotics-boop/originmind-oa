ALTER TABLE `member_sessions` ADD `expires_at` text;--> statement-breakpoint
UPDATE `member_sessions`
SET `expires_at` = strftime('%Y-%m-%dT%H:%M:%fZ', `created_at`, '+30 days')
WHERE `expires_at` IS NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `nda_accepted_at` text;--> statement-breakpoint
ALTER TABLE `members` ADD `nda_approval_id` text;--> statement-breakpoint
UPDATE `members`
SET
	`nda_approval_id` = (
		SELECT `approvals`.`id`
		FROM `approvals`
		WHERE `approvals`.`type` = '保密协议'
			AND `approvals`.`status` = '已归档'
			AND lower(`approvals`.`requester_email`) = lower(`members`.`chatgpt_account`)
		ORDER BY `approvals`.`updated_at` DESC, `approvals`.`id` DESC
		LIMIT 1
	),
	`nda_accepted_at` = (
		SELECT `approvals`.`updated_at`
		FROM `approvals`
		WHERE `approvals`.`type` = '保密协议'
			AND `approvals`.`status` = '已归档'
			AND lower(`approvals`.`requester_email`) = lower(`members`.`chatgpt_account`)
		ORDER BY `approvals`.`updated_at` DESC, `approvals`.`id` DESC
		LIMIT 1
	)
WHERE `nda_accepted_at` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `approvals`
		WHERE `approvals`.`type` = '保密协议'
			AND `approvals`.`status` = '已归档'
			AND lower(`approvals`.`requester_email`) = lower(`members`.`chatgpt_account`)
	);--> statement-breakpoint
UPDATE `approvals`
SET `period_key` = NULL
WHERE `type` <> '劳务报酬'
	AND `period_key` IS NOT NULL;--> statement-breakpoint
UPDATE `approvals`
SET `period_key` = NULL
WHERE `type` = '劳务报酬';--> statement-breakpoint
UPDATE `approvals`
SET `period_key` = lower(trim(`requester_email`)) || '|' || json_extract(`payload_json`, '$.month')
WHERE `type` = '劳务报酬'
	AND `status` <> '草稿'
	AND json_valid(`payload_json`)
	AND json_type(`payload_json`, '$.month') = 'text'
	AND length(json_extract(`payload_json`, '$.month')) = 7
	AND json_extract(`payload_json`, '$.month') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
	AND substr(json_extract(`payload_json`, '$.month'), 6, 2) BETWEEN '01' AND '12';--> statement-breakpoint
INSERT INTO `approval_events` (`approval_id`, `actor_name`, `actor_email`, `action`, `note`)
SELECT
	`duplicate`.`id`,
	'系统迁移',
	'system',
	'migration_period_conflict',
	'历史数据中存在同一成员同一月份的重复劳务申请；本记录未占用唯一月份键，需管理员人工核查。'
FROM `approvals` AS `duplicate`
WHERE `duplicate`.`type` = '劳务报酬'
	AND `duplicate`.`period_key` IS NOT NULL
	AND `duplicate`.`id` <> (
		SELECT `keeper`.`id`
		FROM `approvals` AS `keeper`
		WHERE `keeper`.`type` = '劳务报酬'
			AND `keeper`.`period_key` = `duplicate`.`period_key`
		ORDER BY `keeper`.`created_at` ASC, `keeper`.`id` ASC
		LIMIT 1
	);--> statement-breakpoint
UPDATE `approvals`
SET `period_key` = NULL
WHERE `type` = '劳务报酬'
	AND `period_key` IS NOT NULL
	AND `id` <> (
		SELECT `keeper`.`id`
		FROM `approvals` AS `keeper`
		WHERE `keeper`.`type` = '劳务报酬'
			AND `keeper`.`period_key` = `approvals`.`period_key`
		ORDER BY `keeper`.`created_at` ASC, `keeper`.`id` ASC
		LIMIT 1
	);--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_period_key_active_unique` ON `approvals` (`period_key`) WHERE "approvals"."period_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `direct_messages_sender_recipient_created_idx` ON `direct_messages` (`sender_email`,`recipient_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `direct_messages_recipient_sender_created_idx` ON `direct_messages` (`recipient_email`,`sender_email`,`created_at`);
