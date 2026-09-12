import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DATABASE_NAME,
  EXPECTED_CONFIRMATION,
  HOSTNAME,
  buildWranglerConfig,
  exactDnsRecord,
  parseWorkerSecretNames,
  selectExactDatabase,
  validateReleaseEnvironment,
} from "./release-support.mjs";

const accountId = "1234567890abcdef1234567890abcdef";
const databaseId = "12345678-1234-4234-9234-1234567890ab";
const releaseId = `${"a".repeat(40)}-1`;

function validEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CHAT_RELEASE_CONFIRM: EXPECTED_CONFIRMATION,
    GITHUB_REF: "refs/heads/main",
    CHAT_RELEASE_ID: releaseId,
    CHAT_ADMIN_EMAIL: "maganrobotics@gmail.com",
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token-long-enough",
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
    ...overrides,
  };
}

test("optional generated and administrator credentials may be absent", () => {
  const environment = validateReleaseEnvironment(validEnvironment());
  assert.equal(environment.encryptionKey, "");
  assert.equal(environment.rateLimitKey, "");
  assert.equal(environment.adminPassword, "");
});

test("generated Wrangler targets use explicit Worker-first static routing", () => {
  const staging = buildWranglerConfig({
    accountId,
    adminEmail: "maganrobotics@gmail.com",
    databaseId,
    configPath: "/tmp/chat-release/wrangler.staging.json",
    origin: "https://originmind-public-chat-production.example.workers.dev",
    production: false,
    releaseId,
  });
  assert.equal(staging.workers_dev, true);
  assert.equal(staging.routes, undefined);
  assert.match(staging.assets.directory, /(?:^|\/)public$/u);
  assert.deepEqual({ ...staging.assets, directory: "<chat-public>" }, {
    directory: "<chat-public>",
    binding: "ASSETS",
    html_handling: "none",
    not_found_handling: "none",
    run_worker_first: ["/*", "!/assets/*", "!/favicon.svg", "!/LICENSES.md"],
  });

  const production = buildWranglerConfig({
    accountId,
    adminEmail: "maganrobotics@gmail.com",
    databaseId,
    configPath: "/tmp/chat-release/wrangler.production.json",
    origin: `https://${HOSTNAME}`,
    production: true,
    releaseId,
  });
  assert.equal(production.workers_dev, false);
  assert.deepEqual(production.routes, [{ pattern: `${HOSTNAME}/*`, zone_name: "omindos.ai" }]);
  assert.equal(production.d1_databases[0].database_name, DATABASE_NAME);
});

test("D1 selection requires one exact, valid database", () => {
  assert.deepEqual(selectExactDatabase([{ name: DATABASE_NAME, uuid: databaseId }]), {
    name: DATABASE_NAME,
    id: databaseId,
  });
  assert.throws(
    () => selectExactDatabase([
      { name: DATABASE_NAME, uuid: databaseId },
      { name: DATABASE_NAME, uuid: "22345678-1234-4234-9234-1234567890ab" },
    ]),
    /exactly one D1/u,
  );
});

test("DNS selection is exact and can pin the Tencent IPv4 origin", () => {
  const record = {
    id: "f".repeat(32),
    type: "A",
    name: HOSTNAME,
    content: "203.0.113.10",
    ttl: 300,
    proxiable: true,
    proxied: false,
  };
  assert.equal(exactDnsRecord([record], "203.0.113.10").content, "203.0.113.10");
  assert.throws(() => exactDnsRecord([record, { ...record, id: "e".repeat(32) }]), /exactly one DNS/u);
  assert.throws(() => exactDnsRecord([record], "203.0.113.11"), /does not match/u);
});

test("Worker secret inspection exposes names only and rejects ambiguity", () => {
  assert.deepEqual(
    [...parseWorkerSecretNames([
      { name: "APP_ENCRYPTION_KEY", type: "secret_text" },
      { name: "RATE_LIMIT_HMAC_KEY", type: "secret_text" },
    ])],
    ["APP_ENCRYPTION_KEY", "RATE_LIMIT_HMAC_KEY"],
  );
  assert.throws(
    () => parseWorkerSecretNames([{ name: "APP_ENCRYPTION_KEY" }, { name: "APP_ENCRYPTION_KEY" }]),
    /duplicate names/u,
  );
  assert.throws(() => parseWorkerSecretNames([{ name: "bad-name" }]), /invalid secret descriptor/u);
});
