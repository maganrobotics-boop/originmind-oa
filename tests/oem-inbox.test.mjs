import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const db = new DatabaseSync(':memory:');
db.exec(await readFile(new URL('../migrations/website/0002_oem_applications.sql', import.meta.url), 'utf8'));
for (let i = 0; i < 30; i++) db.prepare('INSERT INTO oem_applications VALUES (?, ?, ?, ?, ?, ?, ?)').run(`OEM-${crypto.randomUUID()}`, crypto.randomUUID(), 'hash', 'zh', JSON.stringify({ company: `Company ${i}` }), 1788770000000, 'hash');
const state = { actor: null, reads: 0, env: { WEBSITE_DB: { prepare(query, params = []) { return { bind(...values) { return state.env.WEBSITE_DB.prepare(query, values); }, async all() { state.reads++; return { results: db.prepare(query).all(...params) }; } }; } } } };
globalThis.__oemInboxTest = state;
const vite = await createServer({ appType: 'custom', configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false }, plugins: [{ name: 'oem-test', enforce: 'pre', resolveId(source) { if (source === 'cloudflare:workers') return '\0oem-env'; if (source.endsWith('/_lib/auth')) return '\0oem-auth'; }, load(id) { if (id === '\0oem-env') return 'export const env = globalThis.__oemInboxTest.env;'; if (id === '\0oem-auth') return 'export const getAuthorizedUser = async () => globalThis.__oemInboxTest.actor;'; } }] });
const route = await vite.ssrLoadModule('/app/api/admin/oem-applications/route.ts');
after(async () => { db.close(); delete globalThis.__oemInboxTest; await vite.close(); });
test('only an admitted administrator can read OEM contacts', async () => {
  for (const actor of [null, { isAdmin: false, ndaCompleted: true }, { isAdmin: true, ndaCompleted: false }]) { state.actor = actor; assert.equal((await route.GET(new Request('https://oa.omindos.ai/api/admin/oem-applications'))).status, 403); }
  assert.equal(state.reads, 0);
});
test('OEM inbox uses bounded pagination, including equal timestamps', async () => {
  state.actor = { isAdmin: true, ndaCompleted: true };
  const response = await route.GET(new Request('https://oa.omindos.ai/api/admin/oem-applications'));
  assert.equal(response.status, 200);
  const first = await response.json(); assert.equal(first.applications.length, 25);
  const second = await (await route.GET(new Request(`https://oa.omindos.ai/api/admin/oem-applications?cursor=${encodeURIComponent(first.nextCursor)}`))).json();
  assert.equal(second.applications.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.applications, ...second.applications].map((row) => row.id)).size, 30);
  assert.equal((await route.GET(new Request('https://oa.omindos.ai/api/admin/oem-applications?cursor=invalid'))).status, 400);
});
