import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

after(async () => {
  await vite.close();
});

const { readBoundedJsonObject } = await vite.ssrLoadModule("/lib/bounded-json-request.ts");
const encoder = new TextEncoder();

function requestWithChunks(chunks, { close = true, onCancel = () => {} } = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      if (close && index === chunks.length) controller.close();
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
  return new Request("https://oa.example.test/api", { method: "POST", body, duplex: "half" });
}

test("chunked request is cancelled as soon as it exceeds the byte limit", async () => {
  let cancelled = false;
  const request = requestWithChunks([encoder.encode("12345678"), encoder.encode("9")], {
    close: false,
    onCancel: () => { cancelled = true; },
  });
  const result = await readBoundedJsonObject(request, 8);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_large");
  assert.equal(cancelled, true);
});

test("missing and empty bodies are rejected", async () => {
  const missing = await readBoundedJsonObject(new Request("https://oa.example.test/api", { method: "POST" }), 32);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "empty_body");

  const empty = await readBoundedJsonObject(requestWithChunks([]), 32);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty_body");
});

test("invalid UTF-8 and invalid JSON are distinguished and rejected", async () => {
  const invalidUtf8 = await readBoundedJsonObject(requestWithChunks([
    new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  ]), 64);
  assert.equal(invalidUtf8.ok, false);
  assert.equal(invalidUtf8.reason, "invalid_utf8");

  const invalidJson = await readBoundedJsonObject(requestWithChunks([encoder.encode('{"a":]')]), 64);
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.reason, "invalid_json");
});

test("non-object JSON is rejected", async () => {
  for (const input of ["null", "[]", '"text"', "1"]) {
    const result = await readBoundedJsonObject(requestWithChunks([encoder.encode(input)]), 64);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non_object");
  }
});

test("an object exactly at the limit is accepted across UTF-8 chunk boundaries", async () => {
  const encoded = encoder.encode('{"name":"四"}');
  const split = encoded.indexOf(0xe5) + 1;
  const request = requestWithChunks([encoded.slice(0, split), encoded.slice(split)]);
  const result = await readBoundedJsonObject(request, encoded.byteLength);
  assert.equal(result.ok, true);
  assert.equal(result.byteLength, encoded.byteLength);
  assert.equal(result.value.name, "四");
});
