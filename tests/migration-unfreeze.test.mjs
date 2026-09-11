import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaMigrationUnfreezeTestState";
const environmentKeys = ["OA_MIGRATION_WRITE_FROZEN", "OA_MIGRATION_UNFREEZE_ENABLED", "OA_MIGRATION_FREEZE_ID", "OA_MIGRATION_EXPORT_NOT_AFTER"];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

function initialState(overrides = {}) {
  return {
    authorized: { isAdmin: true, memberId: "member-admin", accountUserId: "email:admin@example.com", ndaCompleted: true },
    authCalls: 0,
    batchCalls: 0,
    batchResults: [
      { success: true, results: [{ freeze_id: "11111111-2222-4333-8444-555555555555" }] },
      { success: true, results: [{ active_count: 0 }] },
    ],
    throwBatch: false,
    ...overrides,
  };
}

globalThis[stateKey] = initialState();

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "migration-unfreeze-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "cloudflare:workers") return "\0migration-unfreeze-cloudflare";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)\.\.\/\.\.\/_lib\/auth$/u.test(source)) return "\0migration-unfreeze-auth";
      return null;
    },
    load(id) {
      if (id === "\0migration-unfreeze-cloudflare") return `
        export const env = { DB: {
          prepare(sql) { return { sql, bind() { return this; } }; },
          async batch() {
            globalThis.${stateKey}.batchCalls += 1;
            if (globalThis.${stateKey}.throwBatch) throw new Error("D1 unavailable");
            return globalThis.${stateKey}.batchResults;
          },
        } };
      `;
      if (id === "\0migration-unfreeze-auth") return `
        export async function getAuthorizedUser() {
          globalThis.${stateKey}.authCalls += 1;
          return globalThis.${stateKey}.authorized;
        }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/admin/migration-unfreeze/route.ts");

after(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis[stateKey];
  await vite.close();
});

function reset(overrides = {}) {
  process.env.OA_MIGRATION_WRITE_FROZEN = "true";
  process.env.OA_MIGRATION_UNFREEZE_ENABLED = "true";
  process.env.OA_MIGRATION_FREEZE_ID = "11111111-2222-4333-8444-555555555555";
  process.env.OA_MIGRATION_EXPORT_NOT_AFTER = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  globalThis[stateKey] = initialState(overrides);
  return globalThis[stateKey];
}

function request(headers = {}, body = "confirmation=discard-current-migration-package") {
  return new Request("https://oa.example.test/api/admin/migration-unfreeze", {
    method: "POST",
    headers: {
      origin: "https://oa.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

test("migration unfreeze is hidden by default and rejects foreign origins before authentication", async () => {
  let state = reset();
  process.env.OA_MIGRATION_UNFREEZE_ENABLED = "false";
  let response = await route.POST(request());
  assert.equal(response.status, 404);
  assert.equal(state.authCalls, 0);
  assert.equal(state.batchCalls, 0);

  state = reset();
  process.env.OA_MIGRATION_EXPORT_NOT_AFTER = new Date(Date.now() + 60 * 1000).toISOString();
  response = await route.POST(request());
  assert.equal(response.status, 404);
  assert.equal(state.authCalls, 0);
  assert.equal(state.batchCalls, 0);

  state = reset();
  response = await route.POST(request({ origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.equal(state.authCalls, 0);
  assert.equal(state.batchCalls, 0);
});

test("migration unfreeze requires a deliberate confirmation and an admitted administrator", async () => {
  let state = reset();
  let response = await route.POST(request({}, "confirmation=no"));
  assert.equal(response.status, 400);
  assert.equal(state.authCalls, 0);

  state = reset({ authorized: { isAdmin: true, memberId: "member-admin", accountUserId: "email:admin@example.com", ndaCompleted: false } });
  response = await route.POST(request());
  assert.equal(response.status, 403);
  assert.equal(state.authCalls, 1);
  assert.equal(state.batchCalls, 0);
});

test("migration unfreeze deactivates only the exact generation and verifies no active gate remains", async () => {
  let state = reset();
  let response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.equal(state.batchCalls, 1);
  assert.match((await response.json()).message, /迁移包.*必须销毁/u);

  state = reset({ batchResults: [{ success: true, results: [] }, { success: true, results: [{ active_count: 1 }] }] });
  response = await route.POST(request());
  assert.equal(response.status, 409);
  assert.equal(state.batchCalls, 1);

  state = reset({ throwBatch: true });
  response = await route.POST(request());
  assert.equal(response.status, 500);
  assert.equal(state.batchCalls, 1);
});
