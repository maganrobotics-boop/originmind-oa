import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaFeishuNameBindingTestState";

function feishuUser(overrides = {}) {
  return {
    email: "feishu_member@feishu.oa.invalid",
    displayName: "王心远",
    authProvider: "feishu",
    externalSubject: "cli_test:tenant_test:ou_test_member",
    externalLogin: "ou_test_member",
    ...overrides,
  };
}

function initialState() {
  return {
    user: feishuUser(),
    cookieToken: "session-token",
    memberRows: [],
    identityRows: [],
    dbCalls: 0,
    batches: [],
    rateAllowed: true,
  };
}

globalThis[stateKey] = initialState();

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  ssr: { noExternal: ["next"] },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "feishu-name-binding-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "next/headers") return "\0feishu-name-binding-headers";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0feishu-name-binding-db";
      if (/(^|\/)lib\/feishu-oauth$/u.test(source)) return "\0feishu-name-binding-oauth";
      if (/(^|\/)lib\/write-rate-limit$/u.test(source)) return "\0feishu-name-binding-rate";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0feishu-name-binding-auth";
      return null;
    },
    load(id) {
      if (id === "\0feishu-name-binding-headers") return `
        export async function cookies() {
          return { get(name) { return name === "__Host-oa_oauth_session" && globalThis.${stateKey}.cookieToken ? { value: globalThis.${stateKey}.cookieToken } : undefined; } };
        }
      `;
      if (id === "\0feishu-name-binding-oauth") return `
        export const FEISHU_PROVIDER = "feishu";
        export function getFeishuOAuthConfig() { return { origin: "https://oa.example.test" }; }
      `;
      if (id === "\0feishu-name-binding-rate") return `
        export async function consumeWriteRateLimit() { return globalThis.${stateKey}.rateAllowed; }
      `;
      if (id === "\0feishu-name-binding-auth") return `
        export async function getCurrentUser() { return globalThis.${stateKey}.user; }
        export async function hashToken(value) { return "hash:" + value; }
      `;
      if (id === "\0feishu-name-binding-db") return `
        import { sql } from "drizzle-orm";
        const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
        const operation = (kind, table, value) => ({
          kind,
          table: tableName(table),
          value,
          returning() { return { kind, table: tableName(table), value, returnsRows: true }; },
        });
        export async function getDb() {
          const state = globalThis.${stateKey};
          state.dbCalls += 1;
          const takeRows = (table) => table === "members" ? state.memberRows.shift() || [] : table === "auth_identities" ? state.identityRows.shift() || [] : [];
          return {
            select() {
              let table = "unknown";
              const builder = {
                from(value) { table = tableName(value); return builder; },
                where() { return builder; },
                limit() { return Promise.resolve(takeRows(table)); },
                getSQL() { return sql\`SELECT 1\`; },
                then(resolve, reject) { return Promise.resolve(takeRows(table)).then(resolve, reject); },
              };
              return builder;
            },
            insert(table) { return { select(value) { return operation("insert", table, value); } }; },
            update(table) { return { set(value) { return { where() { return operation("update", table, value); } }; } }; },
            async batch(operations) {
              state.batches.push(operations);
              return [[{ id: "identity" }], [{ id: 1 }], [{ tokenHash: "hash:session-token" }]];
            },
          };
        }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/auth/feishu/name-binding/route.ts");

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function bindingRequest(memberId, origin = "https://oa.example.test") {
  return new Request("https://oa.example.test/api/auth/feishu/name-binding", {
    method: "POST",
    headers: { origin, "sec-fetch-site": origin === "https://oa.example.test" ? "same-origin" : "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ memberId, confirmation: "confirm-feishu-name-binding" }),
  });
}

test("an unbound Feishu member sees only exact-name accounts without an active Feishu binding", async () => {
  resetState({
    memberRows: [[
      { memberId: "candidate-one", fullName: "王心远", chatgptAccount: "wang@example.com", departmentCode: "agent_os" },
      { memberId: "candidate-linked", fullName: "王心远", chatgptAccount: "other@example.com", departmentCode: "" },
    ]],
    identityRows: [[{ memberId: "candidate-linked" }]],
  });

  const response = await route.GET();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.matchedName, "王心远");
  assert.deepEqual(payload.candidates, [{
    memberId: "candidate-one",
    fullName: "王心远",
    accountHint: "wa***@example.com",
    department: "Agent OS",
  }]);
});

test("explicit same-name confirmation binds the Feishu subject and upgrades the current OAuth session", async () => {
  const memberId = "11111111-1111-4111-8111-111111111111";
  const state = resetState({
    memberRows: [[{ id: memberId, fullName: "王心远", chatgptAccount: "wang@example.com", accountUserId: "email:wang@example.com", mutationRevision: "revision-one", status: "active" }]],
  });

  const response = await route.POST(bindingRequest(memberId));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.bound, true);
  assert.equal(state.batches.length, 1);
  assert.deepEqual(state.batches[0].map((operation) => [operation.kind, operation.table]), [
    ["insert", "auth_identities"],
    ["insert", "member_events"],
    ["update", "oauth_sessions"],
  ]);
  assert.equal(state.batches[0][2].value.memberId, memberId);
  assert.equal(state.batches[0][2].value.emailSnapshot, "wang@example.com");
});

test("name mismatch and cross-site requests cannot bind a candidate", async () => {
  const memberId = "22222222-2222-4222-8222-222222222222";
  const crossSiteState = resetState();
  const crossSite = await route.POST(bindingRequest(memberId, "https://attacker.example"));
  assert.equal(crossSite.status, 403);
  assert.equal(crossSiteState.dbCalls, 0);

  const mismatchState = resetState({
    memberRows: [[{ id: memberId, fullName: "同名以外的人", chatgptAccount: "other@example.com", accountUserId: "email:other@example.com", mutationRevision: "revision-two", status: "active" }]],
  });
  const mismatch = await route.POST(bindingRequest(memberId));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatchState.batches.length, 0);
});

test("binding implementation requires an unbound live session, an unused subject, and an explicit audit event", async () => {
  const source = await readFile(new URL("../app/api/auth/feishu/name-binding/route.ts", import.meta.url), "utf8");
  assert.match(source, /body\.confirmation !== "confirm-feishu-name-binding"/u);
  assert.match(source, /isNull\(oauthSessions\.memberId\)/u);
  assert.match(source, /notExists\(db\.select\(\{ id: authIdentities\.id \}\)\.from\(authIdentities\)/u);
  assert.match(source, /feishu_identity_name_confirmed/u);
  assert.match(source, /未按姓名静默合并/u);
});
