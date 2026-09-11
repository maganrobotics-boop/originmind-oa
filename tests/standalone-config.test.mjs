import assert from "node:assert/strict";
import test from "node:test";

import { buildStandaloneConfig, deploymentTarget } from "../lib/standalone-config.mjs";

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
  assert.deepEqual(config.secrets.required, ["GITHUB_OAUTH_CLIENT_SECRET", "FEISHU_LOGIN_APP_SECRET"]);
  assert.doesNotMatch(JSON.stringify(config.vars), /secret|token/iu);
});

test("standalone staging config rejects placeholders, missing admin tuples, and production targets", () => {
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_D1_DATABASE_ID: "00000000-0000-4000-8000-000000000000",
  }), /real non-zero D1 UUID/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_ADMIN_NAMES: "",
  }), /configured together/u);
  assert.throws(() => buildStandaloneConfig("production", validEnvironment), /Only the isolated staging/u);
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
    OA_STAGING_PUBLIC_ORIGIN: "https://oa.omindos.ai",
  }), /isolated HTTPS/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://oa.originmindos.com",
  }), /isolated HTTPS/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://oa-staging.originmindos.com",
  }), /workers\.dev origin/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://another-worker.example.workers.dev",
  }), /workers\.dev origin/u);
  assert.throws(() => buildStandaloneConfig("staging", {
    ...validEnvironment,
    OA_STAGING_PUBLIC_ORIGIN: "https://originmind-oa-staging.example.workers.dev:8443",
  }), /workers\.dev origin/u);
});
