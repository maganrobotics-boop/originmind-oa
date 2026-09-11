CREATE TABLE `approval_revisions` (
	`revision_hash` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`revision_no` integer NOT NULL,
	`previous_revision_hash` text,
	`mutation_revision` text NOT NULL,
	`state_json` text NOT NULL,
	`state_hash` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_revisions_approval_no_unique` ON `approval_revisions` (`approval_id`,`revision_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `approval_revisions_approval_mutation_unique` ON `approval_revisions` (`approval_id`,`mutation_revision`);--> statement-breakpoint
CREATE INDEX `approval_revisions_approval_created_idx` ON `approval_revisions` (`approval_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `approval_revisions_no_update`
BEFORE UPDATE ON `approval_revisions`
BEGIN
	SELECT RAISE(ABORT, 'approval revisions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `approval_revisions_no_delete`
BEFORE DELETE ON `approval_revisions`
BEGIN
	SELECT RAISE(ABORT, 'approval revisions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `approval_revisions_chain_guard`
BEFORE INSERT ON `approval_revisions`
WHEN
	NEW.`revision_no` < 1
	OR (NEW.`revision_no` = 1 AND NEW.`previous_revision_hash` IS NOT NULL)
	OR (
		NEW.`revision_no` > 1
		AND NOT EXISTS (
			SELECT 1 FROM `approval_revisions` AS `parent`
			WHERE `parent`.`approval_id` = NEW.`approval_id`
				AND `parent`.`revision_no` = NEW.`revision_no` - 1
				AND `parent`.`revision_hash` = NEW.`previous_revision_hash`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid approval revision chain');
END;--> statement-breakpoint
ALTER TABLE `approvals` ADD `business_key` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `current_revision_no` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `current_revision_hash` text;--> statement-breakpoint
UPDATE `approvals` AS `candidate`
SET `business_key` = 'nda|' || lower(`candidate`.`requester_email`) || '|' || CASE WHEN json_valid(`candidate`.`payload_json`) THEN json_extract(`candidate`.`payload_json`, '$.agreementVersion') ELSE '' END
WHERE `candidate`.`type` = '保密协议'
	AND `candidate`.`status` <> '草稿'
	AND CASE WHEN json_valid(`candidate`.`payload_json`) THEN json_type(`candidate`.`payload_json`, '$.agreementVersion') = 'text' ELSE 0 END
	AND `candidate`.`id` = (
		SELECT `first_record`.`id`
		FROM `approvals` AS `first_record`
		WHERE `first_record`.`type` = '保密协议'
			AND `first_record`.`status` <> '草稿'
			AND lower(`first_record`.`requester_email`) = lower(`candidate`.`requester_email`)
			AND CASE WHEN json_valid(`first_record`.`payload_json`) THEN json_extract(`first_record`.`payload_json`, '$.agreementVersion') = json_extract(`candidate`.`payload_json`, '$.agreementVersion') ELSE 0 END
		ORDER BY CASE WHEN `first_record`.`status` = '已归档' THEN 0 ELSE 1 END, `first_record`.`created_at`, `first_record`.`id`
		LIMIT 1
	);--> statement-breakpoint
INSERT INTO `approval_events` (`approval_id`, `actor_name`, `actor_email`, `action`, `note`, `created_at`)
SELECT
	`invalid_record`.`id`,
	'系统迁移',
	'system@originmind.local',
	'migration_nda_invalid_payload',
	'历史保密协议材料不是有效 JSON，记录已保留但不作为当前版本准入依据；请由管理员核查。',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `approvals` AS `invalid_record`
WHERE `invalid_record`.`type` = '保密协议'
	AND `invalid_record`.`status` <> '草稿'
	AND NOT json_valid(`invalid_record`.`payload_json`);--> statement-breakpoint
INSERT INTO `approval_events` (`approval_id`, `actor_name`, `actor_email`, `action`, `note`, `created_at`)
SELECT
	`duplicate_record`.`id`,
	'系统迁移',
	'system@originmind.local',
	'migration_nda_duplicate',
	'检测到同一成员同一版本的历史保密协议重复记录；本记录保留为历史证据，但不作为当前版本准入依据。',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `approvals` AS `duplicate_record`
WHERE `duplicate_record`.`type` = '保密协议'
	AND `duplicate_record`.`status` <> '草稿'
	AND CASE WHEN json_valid(`duplicate_record`.`payload_json`) THEN json_type(`duplicate_record`.`payload_json`, '$.agreementVersion') = 'text' ELSE 0 END
	AND `duplicate_record`.`business_key` IS NULL
	AND EXISTS (
		SELECT 1 FROM `approvals` AS `canonical_record`
		WHERE `canonical_record`.`business_key` = 'nda|' || lower(`duplicate_record`.`requester_email`) || '|' || CASE WHEN json_valid(`duplicate_record`.`payload_json`) THEN json_extract(`duplicate_record`.`payload_json`, '$.agreementVersion') ELSE '' END
	);--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_business_key_unique` ON `approvals` (`business_key`) WHERE "approvals"."business_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `external_archives` ADD `source_revision_hash` text;--> statement-breakpoint
ALTER TABLE `members` ADD `nda_agreement_version` text;--> statement-breakpoint
UPDATE `members`
SET
	`nda_agreement_version` = 'NDA-2026-09',
	`nda_approval_id` = (
		SELECT `current_nda`.`id`
		FROM `approvals` AS `current_nda`
		WHERE `current_nda`.`type` = '保密协议'
			AND `current_nda`.`status` = '已归档'
			AND lower(`current_nda`.`requester_email`) = lower(`members`.`chatgpt_account`)
			AND CASE WHEN json_valid(`current_nda`.`payload_json`) THEN json_extract(`current_nda`.`payload_json`, '$.agreementVersion') = 'NDA-2026-09' ELSE 0 END
			AND `current_nda`.`business_key` = 'nda|' || lower(`members`.`chatgpt_account`) || '|NDA-2026-09'
		ORDER BY `current_nda`.`updated_at` DESC, `current_nda`.`id` DESC
		LIMIT 1
	),
	`nda_accepted_at` = (
		SELECT `current_nda`.`updated_at`
		FROM `approvals` AS `current_nda`
		WHERE `current_nda`.`type` = '保密协议'
			AND `current_nda`.`status` = '已归档'
			AND lower(`current_nda`.`requester_email`) = lower(`members`.`chatgpt_account`)
			AND CASE WHEN json_valid(`current_nda`.`payload_json`) THEN json_extract(`current_nda`.`payload_json`, '$.agreementVersion') = 'NDA-2026-09' ELSE 0 END
			AND `current_nda`.`business_key` = 'nda|' || lower(`members`.`chatgpt_account`) || '|NDA-2026-09'
		ORDER BY `current_nda`.`updated_at` DESC, `current_nda`.`id` DESC
		LIMIT 1
	)
WHERE EXISTS (
		SELECT 1
		FROM `approvals`
		WHERE `approvals`.`type` = '保密协议'
			AND `approvals`.`status` = '已归档'
			AND lower(`approvals`.`requester_email`) = lower(`members`.`chatgpt_account`)
			AND CASE WHEN json_valid(`approvals`.`payload_json`) THEN json_extract(`approvals`.`payload_json`, '$.agreementVersion') = 'NDA-2026-09' ELSE 0 END
			AND `approvals`.`business_key` = 'nda|' || lower(`members`.`chatgpt_account`) || '|NDA-2026-09'
	);
