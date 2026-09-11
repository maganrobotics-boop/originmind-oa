import assert from "node:assert/strict";
import test from "node:test";

const privateRobotsMeta =
  /<meta(?=[^>]*\bname=["']robots["'])(?=[^>]*\bcontent=["'][^"']*noindex)(?=[^>]*\bcontent=["'][^"']*noarchive)[^>]*>/i;

test("marks the internal OA as non-indexable", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const formAction = (response.headers.get("content-security-policy") ?? "")
    .split(";")
    .map((directive) => directive.trim().split(/\s+/u))
    .find(([name]) => name === "form-action");
  assert.deepEqual(formAction, [
    "form-action",
    "'self'",
    "https://github.com/login/oauth/authorize",
    "https://accounts.feishu.cn",
    "https://passport.feishu.cn",
  ]);
  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /(?:^|;)\s*frame-src\s+https:\/\/passport\.feishu\.cn(?:;|$)/u);
  assert.match(contentSecurityPolicy, /(?:^|;)\s*script-src\s+[^;]*https:\/\/lf-package-cn\.feishucdn\.com(?:;|$)/u);
  assert.match(await response.text(), privateRobotsMeta);
});
