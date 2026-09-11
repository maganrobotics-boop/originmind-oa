import test from "node:test";
import assert from "node:assert/strict";
import { legacyOaRedirect } from "../lib/legacy-oa-redirect.mjs";

test("legacy navigation keeps the destination host fixed and discards query values", () => {
  const response = legacyOaRedirect(new Request("https://oa.originmindos.com/guide?state=private"), "true");
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://oa.omindos.ai/guide");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(legacyOaRedirect(new Request("https://oa.originmindos.com//external.example/"), "true").headers.get("location"), "https://oa.omindos.ai//external.example/");
});

test("old forms and OAuth callbacks do not replay writes or authorization data", () => {
  const post = legacyOaRedirect(new Request("https://oa.originmindos.com/api/approvals", { method: "POST", body: "old-form" }), "true");
  assert.equal(post.status, 303);
  assert.equal(post.headers.get("location"), "https://oa.omindos.ai/");
  const callback = legacyOaRedirect(new Request("https://oa.originmindos.com/api/auth/feishu/callback?code=private&state=private"), "true");
  assert.equal(callback.headers.get("location"), "https://oa.omindos.ai/");
});

test("new production and the preserved source stay outside legacy redirect scope", () => {
  for (const host of ["oa.omindos.ai", "originmind-internal-oa.maganrobotics.chatgpt.site", "example.com"]) {
    assert.equal(legacyOaRedirect(new Request(`https://${host}/`), "true"), null);
  }
  assert.equal(legacyOaRedirect(new Request("https://oa.originmindos.com/"), "false"), null);
});
