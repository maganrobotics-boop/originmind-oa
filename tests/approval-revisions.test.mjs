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

const canonical = await vite.ssrLoadModule("/lib/canonical-json.ts");
const revisions = await vite.ssrLoadModule("/lib/approval-revisions.ts");

function approval(overrides = {}) {
  return {
    id: "approval-001",
    type: "技术审核",
    title: "控制器迭代",
    status: "待审核",
    currentStep: "负责人审核",
    payloadJson: JSON.stringify({ work: "控制算法" }),
    signersJson: "[]",
    currentRevisionId: "self-referential-pointer",
    currentRevisionNo: 999,
    currentRevisionHash: "f".repeat(64),
    ...overrides,
  };
}

function mutation(action, at) {
  return { action, at, mutationId: `${action}-${at}` };
}

function event(action, createdAt) {
  return {
    actorName: "审核人",
    actorEmail: "reviewer@example.com",
    action,
    note: `${action} 审批`,
    createdAt,
  };
}

test("canonical JSON uses deterministic Unicode code-point key order", () => {
  const first = canonical.canonicalJson({
    2: "two",
    10: "ten",
    "😀": "astral",
    "�": "bmp",
    nested: { zeta: 2, alpha: 1 },
  });
  const second = canonical.canonicalJson({
    nested: { alpha: 1, zeta: 2 },
    "�": "bmp",
    "😀": "astral",
    10: "ten",
    2: "two",
  });

  assert.equal(first, second);
  assert.equal(
    first,
    '{"10":"ten","2":"two","nested":{"alpha":1,"zeta":2},"�":"bmp","😀":"astral"}',
  );
});

test("Web Crypto SHA-256 is stable for a fixed vector", async () => {
  assert.equal(
    await canonical.sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("revision snapshots are deterministic and omit only current pointers", async () => {
  const input = {
    nextApproval: approval({ mutationRevision: "keep-this-concurrency-value" }),
    revisionNo: 1,
    previousRevisionHash: null,
    mutation: mutation("submit", "2026-09-01T00:00:00.000Z"),
    event: event("submit", "2026-09-01T00:00:00.000Z"),
  };
  const first = await revisions.buildApprovalRevision(input);
  const second = await revisions.buildApprovalRevision(input);
  const state = JSON.parse(first.stateJson);

  assert.deepEqual(first, second);
  assert.equal(state.currentRevisionId, undefined);
  assert.equal(state.currentRevisionNo, undefined);
  assert.equal(state.currentRevisionHash, undefined);
  assert.equal(state.mutationRevision, "keep-this-concurrency-value");
  assert.match(first.stateHash, /^[a-f0-9]{64}$/);
  assert.match(first.revisionHash, /^[a-f0-9]{64}$/);
});

test("revision chains require contiguous numbers and predecessor hashes", async () => {
  const first = await revisions.buildApprovalRevision({
    nextApproval: approval(),
    revisionNo: 1,
    mutation: mutation("submit", "2026-09-01T00:00:00.000Z"),
    event: event("submit", "2026-09-01T00:00:00.000Z"),
  });
  const second = await revisions.buildApprovalRevision({
    nextApproval: approval({ status: "审批中", currentStep: "开发人确认" }),
    revisionNo: 2,
    previousRevisionHash: first.revisionHash,
    mutation: mutation("approve", "2026-09-01T01:00:00.000Z"),
    event: event("approve", "2026-09-01T01:00:00.000Z"),
  });

  assert.equal(await revisions.verifyRevisionChain([first, second]), true);
  assert.equal(
    await revisions.verifyRevisionChain([{ ...first, revisionNo: 2 }, second]),
    false,
  );
  assert.equal(
    await revisions.verifyRevisionChain([
      first,
      { ...second, previousRevisionHash: "0".repeat(64) },
    ]),
    false,
  );
});

test("revision verification detects state and event tampering", async () => {
  const revision = await revisions.buildApprovalRevision({
    nextApproval: approval(),
    revisionNo: 1,
    mutation: mutation("submit", "2026-09-01T00:00:00.000Z"),
    event: event("submit", "2026-09-01T00:00:00.000Z"),
  });
  const tamperedState = revision.stateJson.replace("控制器迭代", "控制器替换");
  const tamperedEvent = revision.eventJson.replace("submit 审批", "伪造审批");

  assert.equal(
    await revisions.verifyRevisionChain([{ ...revision, stateJson: tamperedState }]),
    false,
  );
  assert.equal(
    await revisions.verifyRevisionChain([{ ...revision, eventJson: tamperedEvent }]),
    false,
  );
});

test("signature payload is retained byte-for-byte in immutable state", async () => {
  const signatureDataUrl = `data:image/png;base64,${"c2lnbmF0dXJl".repeat(32)}`;
  const payloadJson = JSON.stringify({
    agreementVersion: "2026-09-01",
    signatureDataUrl,
    signerIdentity: { memberId: "member-001", name: "签署人" },
  });
  const revision = await revisions.buildApprovalRevision({
    nextApproval: approval({ type: "保密协议", payloadJson }),
    revisionNo: 1,
    mutation: mutation("submit", "2026-09-01T00:00:00.000Z"),
    event: event("submit", "2026-09-01T00:00:00.000Z"),
  });

  const storedPayloadJson = JSON.parse(revision.stateJson).payloadJson;
  assert.equal(storedPayloadJson, payloadJson);
  assert.equal(JSON.parse(storedPayloadJson).signatureDataUrl, signatureDataUrl);
});
