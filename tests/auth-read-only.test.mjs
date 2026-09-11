import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaAuthReadOnlyTestState";
const environmentKeys = [
  "CHATGPT_LOGIN_ENABLED",
  "GITHUB_LOGIN_ENABLED",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "OA_PUBLIC_ORIGIN",
  "OA_ADMIN_EMAILS",
  "OA_ADMIN_NAMES",
  "OA_PROJECT_OWNER_EMAILS",
  "OA_PROJECT_OWNER_NAMES",
  "OA_FINANCE_OWNER_EMAILS",
  "OA_FINANCE_OWNER_NAMES",
  "OA_MIGRATION_WRITE_FROZEN",
];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

function archivedNda() {
  return {
    id: "archived-approval",
    archivedAt: "2026-09-01T08:05:00.000Z",
    agreementVersion: "NDA-2026-09",
  };
}

function freshState() {
  const now = Date.now();
  const sessionMember = {
    id: "member-1",
    fullName: "成员甲",
    chatgptAccount: "member@example.com",
    accountUserId: "email:member@example.com",
    accountBindingPreviousStatus: null,
    status: "active",
  };
  const authorizedMember = {
    ...sessionMember,
    role: "member",
    permissionsJson: "[]",
    ndaAcceptedAt: "2026-08-01T00:00:00.000Z",
    ndaApprovalId: "stale-approval",
    ndaAgreementVersion: "NDA-2026-09",
    mutationRevision: "revision-1",
  };
  return {
    cookies: { "__Host-oa_oauth_session": "valid-oauth-token" },
    cookieWrites: [],
    selectCalls: [],
    rows: {
      oauth_sessions: [[{
        tokenHash: "stored-hash",
        provider: "github",
        providerSubject: "12345",
        memberId: "member-1",
        loginSnapshot: "member-login",
        emailSnapshot: "member@example.com",
        displayNameSnapshot: "Mutable Provider Name",
        createdAt: new Date(now - 10 * 60_000).toISOString(),
        lastSeenAt: new Date(now - 2 * 60_000).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
        revokedAt: null,
      }]],
      members: [[sessionMember], [authorizedMember]],
      auth_identities: [[{ id: "identity-1" }]],
      approvals: [[archivedNda()]],
      account_profiles: [[{ lastSeenAt: new Date(now - 2 * 60_000).toISOString() }]],
    },
    writes: [],
    batches: 0,
  };
}

globalThis[stateKey] = freshState();

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  ssr: { noExternal: ["next"] },
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "auth-read-only-test-dependencies",
    enforce: "pre",
    resolveId(source) {
      if (source === "next/headers") return "\0auth-read-only-headers";
      if (/^(?:\.\.\/)+db$/u.test(source)) return "\0auth-read-only-db";
      return null;
    },
    load(id) {
      if (id === "\0auth-read-only-headers") return `
        export async function headers() { return new Headers(); }
        export async function cookies() {
          return {
            get(name) {
              const value = globalThis.${stateKey}.cookies[name];
              return typeof value === "string" ? { value } : undefined;
            },
            set(name, value, options) {
              globalThis.${stateKey}.cookieWrites.push({ name, value, options });
            },
          };
        }
      `;
      if (id === "\0auth-read-only-db") return `
        const tableName = (table) => table?.[Symbol.for("drizzle:Name")] || "unknown";
        export async function getDb() {
          const state = globalThis.${stateKey};
          return {
            select() {
              let source = "unknown";
              const builder = {
                from(table) { source = tableName(table); state.selectCalls.push(source); return builder; },
                innerJoin() { return builder; },
                where() { return builder; },
                orderBy() { return builder; },
                limit() { return Promise.resolve(state.rows[source]?.shift() || []); },
              };
              return builder;
            },
            update(table) {
              const entry = { kind: "update", table: tableName(table), values: undefined };
              return {
                set(values) {
                  entry.values = values;
                  return { where() { state.writes.push(entry); return Promise.resolve([]); } };
                },
              };
            },
            insert(table) {
              return { values(values) { state.writes.push({ kind: "insert", table: tableName(table), values }); return Promise.resolve([]); } };
            },
            delete(table) {
              return { where() { state.writes.push({ kind: "delete", table: tableName(table) }); return Promise.resolve([]); } };
            },
            batch(queries) { state.batches += 1; return Promise.all(queries); },
          };
        }
      `;
      return null;
    },
  }],
});

const auth = await vite.ssrLoadModule("/app/api/_lib/auth.ts");

beforeEach(() => {
  globalThis[stateKey] = freshState();
  process.env.CHATGPT_LOGIN_ENABLED = "false";
  process.env.GITHUB_LOGIN_ENABLED = "true";
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-secret";
  process.env.OA_PUBLIC_ORIGIN = "https://oa.example.test";
  process.env.OA_ADMIN_EMAILS = "admin@example.com";
  process.env.OA_ADMIN_NAMES = "管理员";
  delete process.env.OA_PROJECT_OWNER_EMAILS;
  delete process.env.OA_PROJECT_OWNER_NAMES;
  delete process.env.OA_FINANCE_OWNER_EMAILS;
  delete process.env.OA_FINANCE_OWNER_NAMES;
  delete process.env.OA_MIGRATION_WRITE_FROZEN;
});

after(async () => {
  delete globalThis[stateKey];
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await vite.close();
});

test("read-only authorized preview preserves the authorization result without authentication-side writes", async () => {
  const readOnlyState = globalThis[stateKey];
  const readOnlyAuthorized = await auth.getAuthorizedUser({ readOnly: true });

  assert.equal(readOnlyAuthorized?.memberId, "member-1");
  assert.equal(readOnlyAuthorized?.role, "member");
  assert.equal(readOnlyAuthorized?.ndaCompleted, true);
  assert.equal(readOnlyAuthorized?.ndaApprovalId, "archived-approval");
  assert.equal(readOnlyState.selectCalls.includes("approvals"), true);
  assert.deepEqual(readOnlyState.writes, []);
  assert.equal(readOnlyState.batches, 0);
  assert.deepEqual(readOnlyState.cookieWrites, []);

  globalThis[stateKey] = freshState();
  const defaultState = globalThis[stateKey];
  const defaultAuthorized = await auth.getAuthorizedUser();

  assert.deepEqual(defaultAuthorized, readOnlyAuthorized);
  assert.deepEqual(defaultState.writes.map(({ kind, table }) => [kind, table]), [
    ["update", "oauth_sessions"],
    ["update", "auth_identities"],
    ["update", "members"],
    ["update", "members"],
    ["update", "account_profiles"],
  ]);
  assert.equal(defaultState.batches, 1);
  assert.deepEqual(defaultState.writes[3].values, {
    ndaAcceptedAt: "2026-09-01T08:05:00.000Z",
    ndaApprovalId: "archived-approval",
    ndaAgreementVersion: "NDA-2026-09",
  });
});
