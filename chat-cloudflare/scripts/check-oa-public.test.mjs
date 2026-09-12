import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OA_PUBLIC_RETRIEVE_URL } from "../src/constants.mjs";
import { checkOaPublicRetrieve } from "./check-oa-public.mjs";

const token = "A".repeat(43);
const validPayload = {
  chunks: [{
    id: "1",
    title: "公开知识测试",
    category: "research",
    sectionTitle: "实验室资料",
    paragraphRef: "P1",
    excerpt: "这是已审批并公开的机器人实验室知识。",
    sourceLabel: "已审批公开文件",
    updatedAt: "2026-09-12",
  }],
};

function response(body, status = 200, contentType = "application/json") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

test("OA preflight sends the normalized token and records only safe success evidence", async () => {
  let request;
  const times = [1_000, 1_025];
  const result = await checkOaPublicRetrieve(token, {
    clock: () => times.shift(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(JSON.stringify(validPayload));
    },
  });

  assert.equal(request.url, OA_PUBLIC_RETRIEVE_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(request.options.headers["x-originmind-public-lab-ai-service-token"], token);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), { question: "请根据公开资料简要说明 ARTS Robotics 的机器人研究方向。" });
  assert.deepEqual(result, {
    format: "originmind-chat-oa-public-preflight-v1",
    checkedAt: new Date(1_025).toISOString(),
    origin: "https://oa.omindos.ai",
    classification: "connected_with_public_knowledge",
    httpStatus: 200,
    chunkCount: 1,
    durationMs: 25,
  });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("OA preflight classifies HTTP failures without reading or recording response content", async () => {
  const cases = [
    [301, "unexpected_redirect"],
    [401, "credential_rejected_or_wrong_live_target"],
    [403, "credential_rejected_or_wrong_live_target"],
    [404, "route_missing_or_wrong_live_target"],
    [405, "route_missing_or_wrong_live_target"],
    [429, "rate_limited"],
    [503, "service_unavailable"],
    [502, "edge_or_upstream_failure"],
  ];
  for (const [status, classification] of cases) {
    const hostileBody = `must-not-appear-${token}`;
    const result = await checkOaPublicRetrieve(token, {
      clock: () => 2_000,
      fetchImpl: async () => response(hostileBody, status, "text/plain"),
    });
    assert.equal(result.classification, classification);
    assert.equal(result.httpStatus, status);
    assert.equal(result.chunkCount, null);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes(hostileBody), false);
  }
});

test("OA preflight distinguishes empty knowledge, invalid contracts, and network failures", async () => {
  const empty = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response(JSON.stringify({ chunks: [] })),
  });
  assert.equal(empty.classification, "credential_accepted_empty");
  assert.equal(empty.chunkCount, 0);

  const invalid = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response("{not-json"),
  });
  assert.equal(invalid.classification, "invalid_contract");
  assert.equal(invalid.httpStatus, 200);

  const strictInvalid = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response(JSON.stringify({ chunks: [], extra: true })),
  });
  assert.equal(strictInvalid.classification, "invalid_contract");

  const wrongMediaType = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response(JSON.stringify(validPayload), 200, "text/plain"),
  });
  assert.equal(wrongMediaType.classification, "invalid_contract");

  const oversized = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(16 * 1024 + 1),
      },
    }),
  });
  assert.equal(oversized.classification, "invalid_contract");

  const streamedOversized = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  assert.equal(streamedOversized.classification, "invalid_contract");

  const timeout = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => {
      throw Object.assign(new Error(`hostile-${token}`), { name: "TimeoutError" });
    },
  });
  assert.equal(timeout.classification, "timeout");
  assert.equal(JSON.stringify(timeout).includes(token), false);

  const network = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => {
      throw new Error(`hostile-${token}`);
    },
  });
  assert.equal(network.classification, "network_error");
  assert.equal(JSON.stringify(network).includes(token), false);
});

test("OA preflight rejects a non-normalized token locally", async () => {
  await assert.rejects(
    checkOaPublicRetrieve("copied-secret"),
    /requires a normalized service token/u,
  );
});

test("release gates on OA before the first Cloudflare resource mutation", async () => {
  const entry = await readFile(new URL("./release-cloudflare.mjs", import.meta.url), "utf8");
  assert.ok(entry.indexOf("checkOaPublicRetrieve(environment.publicToken)") > 0);
  assert.ok(
    entry.indexOf("checkOaPublicRetrieve(environment.publicToken)")
      < entry.indexOf("ensureDatabase(bootstrapConfigPath, secretValues)"),
  );
  assert.match(entry, /oa-public-preflight\.json/u);
  assert.match(entry, /connected_with_public_knowledge/u);
});
