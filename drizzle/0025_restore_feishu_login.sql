-- Restore the Feishu login and explicit account-binding path while keeping the
-- retired Feishu Drive archive and directory-crosswalk paths blocked.
DROP TRIGGER IF EXISTS `auth_identities_feishu_retired_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `auth_identities_feishu_retired_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `oauth_sessions_feishu_retired_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `oauth_sessions_feishu_retired_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `oauth_transactions_feishu_retired_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `oauth_transactions_feishu_retired_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `write_rate_buckets_feishu_retired_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `write_rate_buckets_feishu_retired_update`;
--> statement-breakpoint

CREATE TRIGGER `write_rate_buckets_feishu_retired_insert`
BEFORE INSERT ON `write_rate_buckets`
WHEN NEW.`scope` IN ('feishu_crosswalk', 'feishu_crosswalk_assertion')
BEGIN
	SELECT RAISE(ABORT, 'feishu directory crosswalk retired');
END;
--> statement-breakpoint
CREATE TRIGGER `write_rate_buckets_feishu_retired_update`
BEFORE UPDATE OF `scope` ON `write_rate_buckets`
WHEN NEW.`scope` IN ('feishu_crosswalk', 'feishu_crosswalk_assertion')
BEGIN
	SELECT RAISE(ABORT, 'feishu directory crosswalk retired');
END;
