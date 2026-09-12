import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

const expectedHashes = Object.freeze({
  "index.html": "5658d360d41c3e1ae1db32fce1a727392ba2081d9a0a1e8e9faba62c15457a81",
  "favicon.svg": "a58c943def49dd811e1e0eca105e9726f59921dd2f62ec97dae660675c167083",
  "LICENSES.md": "64e76c8a93cee7aa1cf8b8fd0651c713cfa8e1e350964a99280b7e198fc9b91b",
  "assets/index-B3Ovyg1J.css":
    "7fa2aa60d66fdac248561c542af235bddc428c8a35770bf71f5b793556a2a064",
  "assets/index-df266f0a.js":
    "df266f0ac983e935c55f90cfad9abf0375f3f8740fd1c2f48c5f37ca51c50e5c",
});

async function sha256(relativePath) {
  const bytes = await readFile(path.join(publicDir, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

test("copied production assets retain their verified hashes", async () => {
  for (const [relativePath, expected] of Object.entries(expectedHashes)) {
    assert.equal(await sha256(relativePath), expected, relativePath);
  }
});

test("the asset directory contains only the expected release files and _headers", async () => {
  const top = (await readdir(publicDir)).sort();
  assert.deepEqual(top, ["LICENSES.md", "_headers", "assets", "favicon.svg", "index.html"]);
  const assets = (await readdir(path.join(publicDir, "assets"))).sort();
  assert.deepEqual(assets, ["index-B3Ovyg1J.css", "index-df266f0a.js"]);
});

test("HTML uses root-relative immutable assets and remains noindex", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /src="\/assets\/index-df266f0a\.js"/);
  assert.match(html, /href="\/assets\/index-B3Ovyg1J\.css"/);
  assert.match(html, /ARTS Robotics AI Assistant · OriginMind/u);
  assert.match(html, /经 OA 审核公开/u);
});

test("frontend bundle retains every same-origin API route required by the UI", async () => {
  const script = await readFile(
    path.join(publicDir, "assets", "index-df266f0a.js"),
    "utf8",
  );
  for (const route of [
    "/api/status",
    "/api/chat",
    "/api/inquiries",
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/admin/",
  ]) {
    assert.ok(script.includes(route), route);
  }
  assert.ok(script.includes("location.pathname===`/manage`"));
  assert.ok(script.includes("ARTS Robotics AI Assistant"));
  assert.ok(script.includes("ask_arts_robotics_assistant"));
  assert.ok(script.includes("published:0"));
  assert.ok(script.includes("资料已保存为草稿，不会用于公开回答；请在 OA 中提交审核。"));
  assert.ok(script.includes("对外知识必须在 OA 审核为“公开”后由系统接入。"));
  for (const forbidden of [
    "马教授 AI 助手",
    "ask_professor_assistant",
    "legacy_seed",
    "非 OA 审核",
    "published:o.published",
  ]) {
    assert.equal(script.includes(forbidden), false, forbidden);
  }
});
