import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateKey = "__oaStandaloneSecurityTestState";
globalThis[stateKey] = { request: null };

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  server: { middlewareMode: true, hmr: false },
  plugins: [
    {
      name: "standalone-security-test-worker",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/worker/standalone.ts") && (source === "./index" || /\/worker\/index(?:\.ts)?$/u.test(source))) {
          return "\0standalone-security-test-worker";
        }
      },
      load(id) {
        if (id !== "\0standalone-security-test-worker") return undefined;
        return `
          export default {
            async fetch(request) {
              globalThis.${stateKey}.request = request;
              return new Response("ok");
            },
          };
        `;
      },
    },
  ],
});

after(async () => {
  delete globalThis[stateKey];
  await vite.close();
});

const { default: standaloneWorker } = await vite.ssrLoadModule("/worker/standalone.ts");

test("standalone Worker removes forged Sites identity headers before routing", async () => {
  const response = await standaloneWorker.fetch(
    new Request("https://oa-staging.example.test/api/auth/github/start", {
      method: "POST",
      headers: {
        authorization: "Bearer application-session-token",
        "oai-authenticated-user-id": "forged-admin-id",
        "oai-authenticated-user-email": "admin@example.com",
        "OAI-AUTHENTICATED-USER-FULL-NAME": "Forged%20Admin",
        "oai-sites-authorization": "forged-dispatch-token",
        "x-request-id": "request-123",
      },
    }),
    {},
    {},
  );

  assert.equal(response.status, 200);
  const routedRequest = globalThis[stateKey].request;
  assert.ok(routedRequest instanceof Request);
  assert.equal(routedRequest.headers.get("oai-authenticated-user-id"), null);
  assert.equal(routedRequest.headers.get("oai-authenticated-user-email"), null);
  assert.equal(routedRequest.headers.get("oai-authenticated-user-full-name"), null);
  assert.equal(routedRequest.headers.get("oai-sites-authorization"), null);
  assert.equal(routedRequest.headers.get("authorization"), "Bearer application-session-token");
  assert.equal(routedRequest.headers.get("x-request-id"), "request-123");
});
