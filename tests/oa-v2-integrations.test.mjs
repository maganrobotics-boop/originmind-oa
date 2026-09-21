import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { safeWebmailUrl } from "../lib/integration-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaV2IntegrationTests";
const originalWebmailUrl = process.env.OA_WEBMAIL_URL;
globalThis[stateKey] = { authorized: { ndaCompleted: true } };

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "oa-v2-integration-test",
    enforce: "pre",
    resolveId(source) { return /\/_lib\/auth$/u.test(source) ? "\0test-oa-v2-integration-auth" : null; },
    load(id) {
      return id === "\0test-oa-v2-integration-auth"
        ? `export async function getAuthorizedUser(){return globalThis.${stateKey}.authorized;}`
        : null;
    },
  }],
});
const route = await vite.ssrLoadModule("/app/api/integrations/route.ts");

after(async () => {
  if (originalWebmailUrl === undefined) delete process.env.OA_WEBMAIL_URL;
  else process.env.OA_WEBMAIL_URL = originalWebmailUrl;
  await vite.close();
  delete globalThis[stateKey];
});

test("webmail configuration is available only to NDA-admitted OA members", async () => {
  process.env.OA_WEBMAIL_URL = "https://mail.omindos.ai/?_task=mail";
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { webmail: { configured: true, url: "https://mail.omindos.ai/?_task=mail" } });
  globalThis[stateKey].authorized = null;
  assert.equal((await route.GET()).status, 403);
  globalThis[stateKey].authorized = { ndaCompleted: true };
});

test("unsafe or absent webmail values remain an honest unconfigured state", async () => {
  for (const value of ["", "http://mail.example.test", "https://user:secret@mail.example.test/"]) {
    process.env.OA_WEBMAIL_URL = value;
    const response = await route.GET();
    assert.deepEqual(await response.json(), { webmail: { configured: false, url: "" } });
  }
});

test("webmail URL normalization accepts only credential-free HTTPS", () => {
  assert.equal(safeWebmailUrl(" https://mail.example.test/roundcube "), "https://mail.example.test/roundcube");
  assert.equal(safeWebmailUrl("javascript:alert(1)"), "");
  assert.equal(safeWebmailUrl({}), "");
});
