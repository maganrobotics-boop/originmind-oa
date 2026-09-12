import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  AdminInitializationError,
  DATABASE_NAME,
  EXPECTED_CONFIRMATION,
  EXPECTED_REPOSITORY,
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  consumeAdminInitializationEnvironment,
  initializeChatAdmin,
  selectExactDatabase,
  validateAdminInitializationEnvironment,
} from "./initialize-admin.mjs";

const accountId = "1234567890abcdef1234567890abcdef";
const databaseId = "12345678-1234-4234-9234-1234567890ab";
const apiToken = "cloudflare-api-token-long-enough";
const adminPassword = "independent-admin-password";
const commitSha = "a".repeat(40);

function validEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    CHAT_ADMIN_PASSWORD: adminPassword,
    CHAT_ADMIN_INITIALIZATION_CONFIRM: EXPECTED_CONFIRMATION,
    GITHUB_REPOSITORY: EXPECTED_REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: commitSha,
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "1",
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function listPayload() {
  return { success: true, result: [{ name: DATABASE_NAME, uuid: databaseId }] };
}

function queryPayload(results) {
  return { success: true, result: [{ success: true, results, meta: {} }] };
}

function accountRow() {
  return { id: 1, algorithm: PASSWORD_ALGORITHM, iterations: PASSWORD_ITERATIONS };
}

test("environment validation requires the exact repository, main ref, confirmation, and independent secrets", () => {
  assert.equal(validateAdminInitializationEnvironment(validEnvironment()).accountId, accountId);
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ CHAT_ADMIN_PASSWORD: "too-short" })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-chat-admin-password",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ CHAT_ADMIN_INITIALIZATION_CONFIRM: "wrong" })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-confirmation",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ GITHUB_REF: "refs/heads/feature" })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-git-ref",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ CHAT_ADMIN_PASSWORD: apiToken })),
    (error) => error instanceof AdminInitializationError && error.code === "credentials-must-be-independent",
  );
});

test("secret environment values are removed before any network operation", () => {
  const environment = validEnvironment();
  const consumed = consumeAdminInitializationEnvironment(environment);
  assert.equal(consumed.apiToken, apiToken);
  assert.equal(consumed.adminPassword, adminPassword);
  assert.equal("CLOUDFLARE_API_TOKEN" in environment, false);
  assert.equal("CHAT_ADMIN_PASSWORD" in environment, false);
});

test("database selection requires one exact existing production database", () => {
  assert.deepEqual(selectExactDatabase([{ name: DATABASE_NAME, uuid: databaseId }]), {
    id: databaseId,
    name: DATABASE_NAME,
  });
  assert.throws(
    () => selectExactDatabase([]),
    (error) => error instanceof AdminInitializationError && error.code === "database-target-not-unique",
  );
  assert.throws(
    () => selectExactDatabase([
      { name: DATABASE_NAME, uuid: databaseId },
      { name: DATABASE_NAME, uuid: "22345678-1234-4234-9234-1234567890ab" },
    ]),
    (error) => error instanceof AdminInitializationError && error.code === "database-target-not-unique",
  );
});

test("a missing administrator is created with bound parameters and verified", async () => {
  const environment = validEnvironment();
  const calls = [];
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([])),
    jsonResponse(queryPayload([accountRow()])),
    jsonResponse(queryPayload([accountRow()])),
  ];
  const result = await initializeChatAdmin({
    environment,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
    randomBytesImpl: () => Buffer.alloc(32, 7),
    pbkdf2Impl: () => Buffer.alloc(32, 9),
    now: () => "2026-09-12T12:00:00.000Z",
  });

  assert.equal(result.outcome, "created-and-verified");
  assert.equal(result.secretApplied, true);
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /\/d1\/database\?name=originmind-public-chat-production/u);

  const insertBody = JSON.parse(calls[2].options.body);
  assert.match(insertBody.sql, /VALUES \(\?, \?, \?, \?, \?\)/u);
  assert.equal(insertBody.sql.includes(adminPassword), false);
  assert.deepEqual(insertBody.params.slice(0, 3), ["1", PASSWORD_ALGORITHM, String(PASSWORD_ITERATIONS)]);
  assert.ok(insertBody.params.every((value) => typeof value === "string"));
  assert.equal(insertBody.params[3], Buffer.alloc(32, 7).toString("base64"));
  assert.equal(insertBody.params[4], Buffer.alloc(32, 9).toString("base64"));

  const serializedReceipt = JSON.stringify(result);
  for (const secret of [apiToken, adminPassword, insertBody.params[3], insertBody.params[4]]) {
    assert.equal(serializedReceipt.includes(secret), false);
  }
  assert.equal("CLOUDFLARE_API_TOKEN" in environment, false);
  assert.equal("CHAT_ADMIN_PASSWORD" in environment, false);
});

test("an existing administrator is preserved without deriving or applying the supplied password", async () => {
  let randomCalled = false;
  let hashCalled = false;
  const replies = [jsonResponse(listPayload()), jsonResponse(queryPayload([accountRow()]))];
  const result = await initializeChatAdmin({
    environment: validEnvironment(),
    fetchImpl: async () => replies.shift(),
    randomBytesImpl: () => {
      randomCalled = true;
      return Buffer.alloc(32);
    },
    pbkdf2Impl: () => {
      hashCalled = true;
      return Buffer.alloc(32);
    },
  });
  assert.equal(result.outcome, "already-exists-no-change");
  assert.equal(result.secretApplied, false);
  assert.equal(randomCalled, false);
  assert.equal(hashCalled, false);
});

test("a concurrent insert cannot be reported as successful", async () => {
  const replies = [jsonResponse(listPayload()), jsonResponse(queryPayload([])), jsonResponse(queryPayload([]))];
  await assert.rejects(
    initializeChatAdmin({
      environment: validEnvironment(),
      fetchImpl: async () => replies.shift(),
      randomBytesImpl: () => Buffer.alloc(32, 7),
      pbkdf2Impl: () => Buffer.alloc(32, 9),
    }),
    (error) => error instanceof AdminInitializationError && error.code === "admin-initialization-conflict",
  );
});

test("Cloudflare error bodies and credential material are never copied into thrown errors", async () => {
  const hostileText = `${apiToken}:${adminPassword}:derived-hash`;
  await assert.rejects(
    initializeChatAdmin({
      environment: validEnvironment(),
      fetchImpl: async () => jsonResponse({ success: false, errors: [{ message: hostileText }] }, 403),
    }),
    (error) => {
      assert.equal(error.code, "cloudflare-api-failure");
      assert.equal(error.httpStatus, 403);
      assert.equal(String(error).includes(hostileText), false);
      assert.equal(String(error).includes(apiToken), false);
      assert.equal(String(error).includes(adminPassword), false);
      return true;
    },
  );
});

test("the initialization entrypoint and workflow have no deployment, migration, Worker-secret, or DNS mutation path", async () => {
  const source = await readFile(new URL("./initialize-admin.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/initialize-chat-admin.yml", import.meta.url), "utf8");
  const combined = `${source}\n${workflow}`;
  for (const forbidden of [
    /wrangler\s+deploy/iu,
    /d1\s+migrations/iu,
    /secret\s+put/iu,
    /setDnsProxy/u,
    /ensureDatabase/u,
    /dns_records/u,
    /\/workers\/scripts\//u,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
  assert.match(workflow, /environment:\s*\n\s+name: production-oa/u);
  assert.match(workflow, /group: chat-cloudflare-production/u);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
});
