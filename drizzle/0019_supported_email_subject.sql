INSERT INTO `member_events` (`member_id`, `actor_name`, `actor_email`, `action`, `note`, `created_at`)
SELECT
	`member`.`id`,
	'系统迁移',
	'system@originmind.local',
	'migration_supported_email_subject',
	'已按 Sites 认证邮箱绑定受支持的登录账户主体；原成员状态和权限保留，保密协议准入按当前协议证据独立核验。',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `members` AS `member`
WHERE `member`.`account_user_id` IS NULL
	AND length(trim(`member`.`chatgpt_account`)) BETWEEN 3 AND 254
	AND instr(trim(`member`.`chatgpt_account`), '@') > 1
	AND instr(substr(trim(`member`.`chatgpt_account`), instr(trim(`member`.`chatgpt_account`), '@') + 1), '@') = 0
	AND instr(trim(`member`.`chatgpt_account`), '|') = 0
	AND instr(trim(`member`.`chatgpt_account`), ' ') = 0
	AND NOT EXISTS (
		SELECT 1
		FROM `members` AS `duplicate`
		WHERE `duplicate`.`id` <> `member`.`id`
			AND lower(trim(`duplicate`.`chatgpt_account`)) = lower(trim(`member`.`chatgpt_account`))
	);
--> statement-breakpoint
UPDATE `members` AS `member`
SET
	`chatgpt_account` = lower(trim(`member`.`chatgpt_account`)),
	`account_user_id` = 'email:' || lower(trim(`member`.`chatgpt_account`)),
	`mutation_revision` = CASE
		WHEN length(trim(`member`.`mutation_revision`)) = 0 THEN lower(hex(randomblob(16)))
		ELSE `member`.`mutation_revision`
	END
WHERE `member`.`account_user_id` IS NULL
	AND length(trim(`member`.`chatgpt_account`)) BETWEEN 3 AND 254
	AND instr(trim(`member`.`chatgpt_account`), '@') > 1
	AND instr(substr(trim(`member`.`chatgpt_account`), instr(trim(`member`.`chatgpt_account`), '@') + 1), '@') = 0
	AND instr(trim(`member`.`chatgpt_account`), '|') = 0
	AND instr(trim(`member`.`chatgpt_account`), ' ') = 0
	AND NOT EXISTS (
		SELECT 1
		FROM `members` AS `duplicate`
		WHERE `duplicate`.`id` <> `member`.`id`
			AND lower(trim(`duplicate`.`chatgpt_account`)) = lower(trim(`member`.`chatgpt_account`))
	);
