import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaFeishuAutoProvisionTestState";

function feishuUser(overrides = {}) {
  return {
    email: "feishu_member@feishu.invalid",
    displayName: "刘衍青",
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
    memberRows: [[], []],
    identityRows: [[]],
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
    name: "feishu-auto-provision-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "next/headers") return "\0feishu-auto-provision-headers";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0feishu-auto-provision-db";
      if (/(^|\/)lib\/feishu-oauth$/u.test(source)) return "\0feishu-auto-provision-oauth";
      if (/(^|\/)lib\/write-rate-limit$/u.test(source)) return "\0feishu-auto-provision-rate";
      if (/(^|\/)api\/_lib\/auth$/u.test(source) || /(^|\/)_lib\/auth$/u.test(source)) return "\0feishu-auto-provision-auth";
      return null;
    },
    load(id) {
      if (id === "\0feishu-auto-provision-headers") return `
        export async function cookies() {
          return { get(name) { return name === "__Host-oa_oauth_session" && globalThis.${stateKey}.cookieToken ? { value: globalThis.${stateKey}.cookieToken } : undefined; } };
        }
      `;
      if (id === "\0feishu-auto-provision-oauth") return `
        export const FEISHU_PROVIDER = "feishu";
        export function getFeishuOAuthConfig() { return { origin: "https://oa.example.test" }; }
      `;
      if (id === "\0feishu-auto-provision-rate") return `
        export async function consumeWriteRateLimit() { return globalThis.${stateKey}.rateAllowed; }
      `;
      if (id === "\0feishu-auto-provision-auth") return `
        export async function getCurrentUser() { return globalThis.${stateKey}.user; }
        export async function hashToken(value) { return "hash:" + value; }
      `;
      if (id === "\0feishu-auto-provision-db") return `
        import { sql } from "drizzle-orm";
        const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
        const operation = (kind, table, value) => ({
          kind,
          table: tableName(table),
          value,
          where() { return this; },
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
            update(table) { return { set(value) { return operation("update", table, value); } }; },
            async batch(operations) {
              state.batches.push(operations);
              return [[{ id: "member" }], [{ id: "identity" }], [{ id: 1 }], [{ tokenHash: "hash:session-token" }]];
            },
          };
        }
      `;
      return null;
    },
  }],
});

const route = await vite.ssrLoadModule("/app/api/auth/feishu/provision/route.ts");

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

function resetState(overrides = {}) {
  globalThis[stateKey] = { ...initialState(), ...overrides };
  return globalThis[stateKey];
}

function provisionRequest({ origin = "https://oa.example.test", confirmation } = {}) {
  return new Request("https://oa.example.test/api/auth/feishu/provision", {
    method: "POST",
    headers: { origin, "sec-fetch-site": origin === "https://oa.example.test" ? "same-origin" : "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ action: "provision-feishu-member", ...(confirmation ? { confirmation } : {}) }),
  });
}

test("a verified enterprise Feishu member is activated without a registration form", async () => {
  const state = resetState();
  const response = await route.POST(provisionRequest());
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.provisioned, true);
  assert.equal(payload.member.fullName, "刘衍青");
  assert.deepEqual(state.batches[0].map((operation) => [operation.kind, operation.table]), [
    ["insert", "members"],
    ["insert", "auth_identities"],
    ["insert", "member_events"],
    ["update", "oauth_sessions"],
  ]);
  assert.equal(state.batches[0][3].value.memberId.length, 36);
  assert.equal(state.batches[0][3].value.displayNameSnapshot, "刘衍青");
});

test("a same-name account must be shown before a new member can be created", async () => {
  const blockedState = resetState({ memberRows: [[], [{ id: "old-member" }]] });
  const blocked = await route.POST(provisionRequest());
  const blockedPayload = await blocked.json();
  assert.equal(blocked.status, 409);
  assert.equal(blockedPayload.candidatesAvailable, true);
  assert.equal(blockedState.batches.length, 0);

  const confirmedState = resetState({ memberRows: [[], [{ id: "old-member" }]] });
  const confirmed = await route.POST(provisionRequest({ confirmation: "none-of-these-accounts-is-mine" }));
  assert.equal(confirmed.status, 201);
  assert.equal(confirmedState.batches.length, 1);
});

test("cross-site requests and identities outside Feishu cannot provision members", async () => {
  const crossSiteState = resetState();
  const crossSite = await route.POST(provisionRequest({ origin: "https://attacker.example" }));
  assert.equal(crossSite.status, 403);
  assert.equal(crossSiteState.dbCalls, 0);

  const githubState = resetState({ user: feishuUser({ authProvider: "github" }) });
  const github = await route.POST(provisionRequest());
  assert.equal(github.status, 401);
  assert.equal(githubState.dbCalls, 0);
});

test("auto-provisioning creates an active member from Feishu data with an audit event", async () => {
  const source = await readFile(new URL("../app/api/auth/feishu/provision/route.ts", import.meta.url), "utf8");
  assert.match(source, /status: sql<string>`'active'`/u);
  assert.match(source, /identityNumber: sql<string \| null>`NULL`/u);
  assert.match(source, /feishu_member_auto_provisioned/u);
  assert.match(source, /未提交姓名、学号\/工号或额外认证资料/u);
  assert.match(source, /none-of-these-accounts-is-mine/u);
  assert.match(source, /isNull\(oauthSessions\.memberId\)/u);
});
