import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { waitForMigrationImporter } from "../lib/migration-import-readiness.mjs";

test("a process that grabs the local port and returns 404 never authenticates as the importer", async () => {
  let postRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") postRequests += 1;
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await assert.rejects(
      waitForMigrationImporter(`http://127.0.0.1:${port}/ready`, Buffer.alloc(32, 0x5a).toString("base64url"), { exitCode: null }, 300),
      /did not prove its identity/u,
    );
    assert.equal(postRequests, 0);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("only the exact secret proof identifies the local importer", async () => {
  const proof = Buffer.alloc(32, 0x22).toString("base64url");
  let calls = 0;
  const fetchImplementation = async () => {
    calls += 1;
    return Response.json({ ready: calls === 1 ? "wrong-proof" : proof });
  };
  await waitForMigrationImporter("http://127.0.0.1:8789/ready", proof, { exitCode: null }, 1_000, fetchImplementation);
  assert.equal(calls, 2);
});
