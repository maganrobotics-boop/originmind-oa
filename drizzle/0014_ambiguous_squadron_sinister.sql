ALTER TABLE `members` ADD `account_user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `members_account_user_id_unique` ON `members` (`account_user_id`) WHERE "members"."account_user_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO `member_events` (`member_id`, `actor_name`, `actor_email`, `action`, `note`, `created_at`)
SELECT
	`id`,
	'系统迁移',
	'system@originmind.local',
	'migration_account_rebind_required',
	'为防止邮箱回收或重新分配后继承原成员权限，历史成员下次登录须提交不可变 ChatGPT 账户 ID 绑定并由管理员重新核验。',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `members`
WHERE `status` = 'active' AND `account_user_id` IS NULL;
--> statement-breakpoint
UPDATE `members`
SET `nda_accepted_at` = NULL, `nda_approval_id` = NULL, `nda_agreement_version` = NULL
WHERE `account_user_id` IS NULL;
