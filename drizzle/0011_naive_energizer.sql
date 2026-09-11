ALTER TABLE `members` ADD `mutation_revision` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `approvals`
SET
	`status` = '已退回',
	`current_step` = '补充材料',
	`current_reviewer_name` = `requester_name`,
	`current_reviewer_email` = `requester_email`,
	`summary` = substr(`summary` || char(10) || char(10) || '系统迁移提示：月份或技术成果占用存在冲突，请核对后重新提交。', 1, 4000),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `type` = '劳务报酬'
	AND `status` <> '已归档'
	AND EXISTS (
		SELECT 1
		FROM `approval_events` AS `event`
		WHERE `event`.`approval_id` = `approvals`.`id`
			AND `event`.`action` IN ('migration_period_conflict', 'migration_labor_source_conflict', 'migration_labor_claim_unresolved')
	);
