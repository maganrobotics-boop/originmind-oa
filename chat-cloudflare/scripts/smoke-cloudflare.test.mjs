import assert from "node:assert/strict";
import test from "node:test";

import { isTransientSmokeStatus, validateReleaseEvidence } from "./smoke-cloudflare.mjs";

const releaseId = `${"a".repeat(40)}-1`;
const evidence = {
  health: { app: "arts-robotics-ai-assistant", ready: true, releaseId },
  status: { storageReady: true, modelReady: true, provider: "workers-ai", model: "test-model" },
  chat: {
    mode: "ai",
    answer: "经审核公开资料支持该回答。[1]",
    provider: "workers-ai",
    oaPublicStatus: "connected",
    releaseId,
    sources: [{ id: "oa:1", origin: "oa_public" }],
  },
};

test("release evidence accepts only the exact OA-backed Chat release", () => {
  assert.deepEqual(validateReleaseEvidence(evidence, releaseId), {
    app: "arts-robotics-ai-assistant",
    ready: true,
    releaseId,
    oaPublicStatus: "connected",
    provider: "workers-ai",
    model: "test-model",
    sources: 1,
  });
});

test("release evidence rejects stale releases and legacy or local-only knowledge", () => {
  assert.throws(
    () => validateReleaseEvidence({ ...evidence, health: { ...evidence.health, releaseId: `${"b".repeat(40)}-1` } }, releaseId),
    /expected ready/u,
  );
  for (const origin of ["legacy_seed", "chat_admin", "chat_draft"]) {
    assert.throws(
      () => validateReleaseEvidence({
        ...evidence,
        chat: { ...evidence.chat, sources: [{ id: "unsafe", origin }] },
      }, releaseId),
      /exclusively OA-approved/u,
    );
  }
});

test("release evidence rejects unavailable OA and retrieval-only fallback", () => {
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      chat: { ...evidence.chat, mode: "retrieval", oaPublicStatus: "unavailable", sources: [] },
    }, releaseId),
    /OA-backed AI answer/u,
  );
});


test("edge propagation responses are retried without retrying authorization failures", () => {
  for (const status of [undefined, 404, 408, 421, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientSmokeStatus(status), true);
  }
  for (const status of [400, 401, 403, 405]) assert.equal(isTransientSmokeStatus(status), false);
});
