import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStandaloneConfig,
  deploymentTarget,
  productionTarget,
  validatePublicLabAiServiceToken,
} from "../lib/standalone-config.mjs";

const validEnvironment = {
  OA_STAGING_CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  OA_STAGING_WORKER_NAME: "originmind-oa-staging",
  OA_STAGING_D1_DATABASE_NAME: "originmind-oa-staging",
  OA_STAGING_D1_DATABASE_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  OA_STAGING_PUBLIC_ORIGIN: "https://originmind-oa-staging.example.workers.dev",
  GITHUB_OAUTH_CLIENT_ID: "Ov23liExampleClientId",
  FEISHU_LOGIN_APP_ID: "cli_example_app_id",
  FEISHU_LOGIN_TENANT_KEY: "tenant_example_key",
  OA_ADMIN_EMAILS: "admin@example.com",
  OA_ADMIN_NAMES: "OA Admin",
};

const validProductionEnvironment = {
  OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: "fedcba9876543210fedcba9876543210",
  OA_PRODUCTION_WORKER_NAME: "legacy-worker-name",
  OA_PRODUCTION_D1_DATABASE_NAME: "originmind-oa-production",
  OA_PRODUCTION_D1_DATABASE_ID: "7d9e6679-7425-40de-944b-e07fc1f90ae7",
  OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME: "website-visits",
  OA_PRODUCTION_WEBSITE_D1_DATABASE_ID: "1b4e28ba-2fa1-41d2-883f-41d12ac61b91",
  OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME: "originmind-oa-knowledge-assets-production",
  OA_PRODUCTION_PUBLIC_ORIGIN: "https://oa.example.com",
  OA_PRODUCTION_CRON: "* * * * *",
};

test("standalone staging config is isolated and contains every runtime binding", () => {
  const config = buildStandaloneConfig("staging", validEnvironment);
  assert.equal(config.name, deploymentTarget("staging", validEnvironment).workerName);
  assert.equal(config.account_id, validEnvironment.OA_STAGING_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.main, "../../worker/standalone.ts");
  assert.deepEqual(config.assets, {
    binding: "ASSETS",
    not_found_handling: "none",
    run_worker_first: ["/api/*", "/_vinext/*", "/__vinext/*"],
  });
  assert.deepEqual(config.images, { binding: "IMAGES" });
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_name, validEnvironment.OA_STAGING_D1_DATABASE_NAME);
  assert.equal(config.d1_databases[0].database_id, validEnvironment.OA_STAGING_D1_DATABASE_ID);
  assert.equal(config.vars.OA_PUBLIC_ORIGIN, validEnvironment.OA_STAGING_PUBLIC_ORIGIN);
  assert.equal(config.vars.OA_MIGRATION_EXPORT_ENABLED, "false");
  assert.equal(config.vars.OA_MIGRATION_WRITE_FROZEN, "false");
  assert.equal(config.vars.OA_MIGRATION_UNFREEZE_ENABLED, "false");
  assert.equal(config.vars.CHATGPT_LOGIN_ENABLED, "false");
  assert.equal(config.vars.GITHUB_LOGIN_ENABLED, "true");
  assert.equal(config.vars.FEISHU_LOGIN_ENABLED, "true");
  assert.equal(config.vars.FEISHU_LOGIN_APP_ID, validEnvironment.FEISHU_LOGIN_APP_ID);
  assert.equal(config.vars.FEISHU_LOGIN_TENANT_KEY, validEnvironment.FEISHU_LOGIN_TENANT_KEY);
  assert.equal(config.vars.FEISHU_PDF_ARCHIVE_ENABLED, "true");
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.secrets.required, [
    "GITHUB_OAUTH_CLIENT_SECRET",
    "FEISHU_LOGIN_APP_SECRET",
    "PUBLIC_LAB_AI_SERVICE_TOKEN",
  ]);
  assert.doesNotMatch(JSON.stringify(config.vars), /secret|token/iu);
});

test("public lab AI service token accepts only exactly 43 unpadded base64url characters", () => {
  const token = "A".repeat(42) + "_";
  assert.equal(validatePublicLabAiServiceToken(token), token);
  for (const invalid of [
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(42)}+`,
    `${"A".repeat(42)}/`,
    `${"A".repeat(42)} `,
  ]) {
    assert.throws(() => validatePublicLabAiServiceToken(invalid), /exactly 43 unpadded base64url/u);
  }
});

test("standalone staging config rejects placeholders and non-isolated targets", () => {
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_D1_DATABASE_ID: "00000000-0000-4000-8000-000000000000",
  }), /real non-zero D1 UUID/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_ADMIN_NAMES: "",
  }), /configured together/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_WORKER_NAME: "originmind-oa-production",
  }), /ending in -staging/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_D1_DATABASE_NAME: "originmind-oa-production",
  }), /ending in -staging/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://oa.example.com",
  }), /workers\.dev/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://oa-staging.originmindos.com",
  }), /workers\.dev origin/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://another-worker.example.workers.dev",
  }), /must belong/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://originmind-oa-staging.example.workers.dev:8443",
  }), /workers\.dev origin/u);
});

test("standalone production config comes only from injected identifiers and preserves provider state", () => {
  const expected = productionTarget(validProductionEnvironment);
  const config = buildStandaloneConfig("production", validProductionEnvironment);
  assert.equal(config.account_id, expected.accountId);
  assert.equal(config.name, expected.workerName);
  assert.equal(config.d1_databases[0].database_name, expected.databaseName);
  assert.equal(config.d1_databases[0].database_id, expected.databaseId);
  assert.equal(config.d1_databases[1].database_name, expected.websiteDatabaseName);
  assert.equal(config.d1_databases[1].database_id, expected.websiteDatabaseId);
  assert.equal(config.r2_buckets[0].binding, "KNOWLEDGE_ASSETS");
  assert.equal(config.r2_buckets[0].bucket_name, expected.knowledgeAssetsBucketName);
  assert.equal(config.vars.OA_PUBLIC_ORIGIN, expected.publicOrigin);
  assert.equal(config.keep_vars, true);
  assert.equal(config.workers_dev, false);
  assert.equal(config.route, undefined);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.triggers.crons, [expected.cron]);
  assert.ok(config.secrets.required.includes("PUBLIC_LAB_AI_SERVICE_TOKEN"));
  assert.doesNotMatch(JSON.stringify(config.vars), /secret|token/iu);

  assert.throws(() => buildStandaloneConfig("production", {
    ...validProductionEnvironment,
    OA_PRODUCTION_D1_DATABASE_ID: validProductionEnvironment.OA_PRODUCTION_WEBSITE_D1_DATABASE_ID,
  }), /must be distinct/u);
  assert.throws(() => buildStandaloneConfig("production", {
    ...validProductionEnvironment,
    OA_PRODUCTION_PUBLIC_ORIGIN: "https://worker.example.workers.dev",
  }), /custom-domain/u);
  assert.throws(() => buildStandaloneConfig("production", {
    ...validProductionEnvironment,
    OA_PRODUCTION_CRON: "not a cron",
  }), /five-field/u);
  assert.throws(() => buildStandaloneConfig("production", {
    ...validProductionEnvironment,
    OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME: "",
  }), /OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME/u);
  assert.throws(() => buildStandaloneConfig("production", {
    ...validProductionEnvironment,
    OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME: "Invalid_Bucket_Name",
  }), /safe Cloudflare name/u);
});
