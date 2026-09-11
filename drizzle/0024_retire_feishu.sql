-- Refuse to retire identities while a controlled full-database migration freeze is active.
INSERT INTO `migration_control` (`freeze_id`, `activated_at`, `deactivated_at`)
SELECT `freeze_id`, `activated_at`, `deactivated_at`
FROM `migration_control`
WHERE `deactivated_at` IS NULL;
--> statement-breakpoint

-- A remote upload can outlive its D1 lease. Refuse the retirement migration
-- until the old archive route has been disabled and every upload has reached a
-- terminal state; copying a pending row's primary key deliberately aborts.
INSERT INTO `external_archives` (
	`id`, `approval_id`, `destination`, `manifest_hash`, `content_hash`, `file_name`, `status`
)
SELECT
	`id`, `approval_id`, `destination`, `manifest_hash`, `content_hash`, `file_name`, `status`
FROM `external_archives`
WHERE `destination` = 'feishu_drive' AND `status` = 'pending'
LIMIT 1;
--> statement-breakpoint

CREATE TRIGGER `auth_identities_feishu_retired_insert`
BEFORE INSERT ON `auth_identities`
WHEN NEW.`provider` = 'feishu' AND NEW.`unlinked_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_feishu_retired_update`
BEFORE UPDATE OF `provider`, `unlinked_at` ON `auth_identities`
WHEN NEW.`provider` = 'feishu' AND NEW.`unlinked_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint

CREATE TRIGGER `oauth_sessions_feishu_retired_insert`
BEFORE INSERT ON `oauth_sessions`
WHEN NEW.`provider` = 'feishu' AND NEW.`revoked_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_sessions_feishu_retired_update`
BEFORE UPDATE OF `provider`, `revoked_at` ON `oauth_sessions`
WHEN NEW.`provider` = 'feishu' AND NEW.`revoked_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint

CREATE TRIGGER `oauth_transactions_feishu_retired_insert`
BEFORE INSERT ON `oauth_transactions`
WHEN NEW.`provider` = 'feishu' AND NEW.`consumed_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint
CREATE TRIGGER `oauth_transactions_feishu_retired_update`
BEFORE UPDATE OF `provider`, `consumed_at` ON `oauth_transactions`
WHEN NEW.`provider` = 'feishu' AND NEW.`consumed_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint

CREATE TRIGGER `external_archives_feishu_retired_insert`
BEFORE INSERT ON `external_archives`
WHEN NEW.`destination` = 'feishu_drive' AND NEW.`status` = 'pending'
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint
CREATE TRIGGER `external_archives_feishu_retired_update`
BEFORE UPDATE OF `destination`, `status` ON `external_archives`
WHEN NEW.`destination` = 'feishu_drive' AND NEW.`status` = 'pending'
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint

CREATE TRIGGER `write_rate_buckets_feishu_retired_insert`
BEFORE INSERT ON `write_rate_buckets`
WHEN NEW.`scope` IN ('feishu_oauth_start', 'feishu_crosswalk', 'feishu_crosswalk_assertion')
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint
CREATE TRIGGER `write_rate_buckets_feishu_retired_update`
BEFORE UPDATE OF `scope` ON `write_rate_buckets`
WHEN NEW.`scope` IN ('feishu_oauth_start', 'feishu_crosswalk', 'feishu_crosswalk_assertion')
BEGIN
	SELECT RAISE(ABORT, 'feishu integration retired');
END;
--> statement-breakpoint

UPDATE `auth_identities`
SET `unlinked_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `provider` = 'feishu' AND `unlinked_at` IS NULL;
--> statement-breakpoint

UPDATE `oauth_sessions`
SET `revoked_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `provider` = 'feishu' AND `revoked_at` IS NULL;
--> statement-breakpoint

UPDATE `oauth_transactions`
SET `consumed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `provider` = 'feishu' AND `consumed_at` IS NULL;
--> statement-breakpoint

DELETE FROM `write_rate_buckets`
WHERE `scope` IN ('feishu_oauth_start', 'feishu_crosswalk', 'feishu_crosswalk_assertion');
