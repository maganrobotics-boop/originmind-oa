CREATE TABLE `labor_source_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`claimant_member_id` text NOT NULL,
	`claimant_email` text NOT NULL,
	`technical_approval_id` text NOT NULL,
	`labor_approval_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labor_source_claims_member_technical_unique` ON `labor_source_claims` (`claimant_member_id`,`technical_approval_id`);--> statement-breakpoint
CREATE INDEX `labor_source_claims_labor_approval_idx` ON `labor_source_claims` (`labor_approval_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `labor_source_claims` (
	`id`,
	`claimant_member_id`,
	`claimant_email`,
	`technical_approval_id`,
	`labor_approval_id`,
	`created_at`
)
SELECT
	`labor`.`id` || '|' || `member`.`id` || '|' || CAST(`source`.`value` AS text),
	`member`.`id`,
	lower(trim(`labor`.`requester_email`)),
	CAST(`source`.`value` AS text),
	`labor`.`id`,
	`labor`.`created_at`
FROM `approvals` AS `labor`
INNER JOIN `members` AS `member`
	ON lower(trim(`member`.`chatgpt_account`)) = lower(trim(`labor`.`requester_email`))
INNER JOIN json_each(`labor`.`payload_json`, '$.sourceApprovalIds') AS `source`
WHERE `labor`.`type` = '劳务报酬'
	AND `labor`.`status` <> '草稿'
	AND json_valid(`labor`.`payload_json`)
	AND json_type(`labor`.`payload_json`, '$.sourceApprovalIds') = 'array'
	AND `source`.`type` = 'text'
	AND length(trim(CAST(`source`.`value` AS text))) > 0
ORDER BY `labor`.`created_at` ASC, `labor`.`id` ASC, `source`.`key` ASC;--> statement-breakpoint
INSERT INTO `approval_events` (`approval_id`, `actor_name`, `actor_email`, `action`, `note`)
SELECT
	`labor`.`id`,
	'系统迁移',
	'system',
	'migration_labor_source_conflict',
	'历史劳务申请中的技术成果已被同一成员更早的正式申请占用；本记录保留但未获得该成果占用，需管理员人工核查。'
FROM `approvals` AS `labor`
INNER JOIN `members` AS `member`
	ON lower(trim(`member`.`chatgpt_account`)) = lower(trim(`labor`.`requester_email`))
INNER JOIN json_each(`labor`.`payload_json`, '$.sourceApprovalIds') AS `source`
WHERE `labor`.`type` = '劳务报酬'
	AND `labor`.`status` <> '草稿'
	AND json_valid(`labor`.`payload_json`)
	AND json_type(`labor`.`payload_json`, '$.sourceApprovalIds') = 'array'
	AND `source`.`type` = 'text'
	AND length(trim(CAST(`source`.`value` AS text))) > 0
	AND EXISTS (
		SELECT 1
		FROM `labor_source_claims` AS `claim`
		WHERE `claim`.`claimant_member_id` = `member`.`id`
			AND `claim`.`technical_approval_id` = CAST(`source`.`value` AS text)
			AND `claim`.`labor_approval_id` <> `labor`.`id`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `labor_source_claims` AS `own_claim`
		WHERE `own_claim`.`claimant_member_id` = `member`.`id`
			AND `own_claim`.`technical_approval_id` = CAST(`source`.`value` AS text)
			AND `own_claim`.`labor_approval_id` = `labor`.`id`
	)
GROUP BY `labor`.`id`;--> statement-breakpoint
INSERT INTO `approval_events` (`approval_id`, `actor_name`, `actor_email`, `action`, `note`)
SELECT
	`labor`.`id`,
	'系统迁移',
	'system',
	'migration_labor_claim_unresolved',
	'历史劳务申请未能匹配当前成员身份，技术成果占用未回填；本记录需管理员人工核查。'
FROM `approvals` AS `labor`
WHERE `labor`.`type` = '劳务报酬'
	AND `labor`.`status` <> '草稿'
	AND json_valid(`labor`.`payload_json`)
	AND json_type(`labor`.`payload_json`, '$.sourceApprovalIds') = 'array'
	AND json_array_length(`labor`.`payload_json`, '$.sourceApprovalIds') > 0
	AND NOT EXISTS (
		SELECT 1
		FROM `members` AS `member`
		WHERE lower(trim(`member`.`chatgpt_account`)) = lower(trim(`labor`.`requester_email`))
	);
