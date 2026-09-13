import assert from "node:assert/strict";
import test from "node:test";

import {
  frontendAssetPaths,
  isTransientSmokeStatus,
  smokeAdminAuthentication,
  smokeCloudflare,
  smokeSavedAdminAuthentication,
  validateReleaseEvidence,
} from "./smoke-cloudflare.mjs";

const releaseId = `${"a".repeat(40)}-1`;
const evidence = {
  health: { app: "arts-robotics-ai-assistant", ready: true, releaseId },
  status: {
    storageReady: true,
    modelReady: true,
    qwenReady: true,
    oaReady: true,
    knowledgeReady: true,
    retrievalReady: true,
    budgetReady: true,
    systemReady: true,
    provider: "workers-ai",
    model: "test-model",
  },
  chat: {
    mode: "ai",
    answer: "经审核公开资料支持该回答。[1]",
    provider: "workers-ai",
    oaPublicStatus: "connected",
    releaseId,
    sources: [{ id: "oa:1", origin: "oa_public" }],
  },
  adminAuth: { status: 401, error: "密码不正确" },
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
    adminKdfCompatible: true,
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

test("release evidence rejects any unready homepage service light", () => {
  for (const field of ["qwenReady", "oaReady", "knowledgeReady", "retrievalReady", "budgetReady", "systemReady"]) {
    assert.throws(
      () => validateReleaseEvidence({
        ...evidence,
        status: { ...evidence.status, [field]: false },
      }, releaseId),
      (error) => error instanceof Error && error.retryable === true && /five-light homepage/u.test(error.message),
      field,
    );
  }
});

test("release evidence fails fast when the status contract is malformed", () => {
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      status: { ...evidence.status, knowledgeReady: undefined },
    }, releaseId),
    (error) => error instanceof Error && error.retryable !== true && /five-light homepage/u.test(error.message),
  );
});

test("release evidence treats an in-flight status probe as retryable", () => {
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      status: { ...evidence.status, modelReady: false, qwenReady: false, modelPending: true },
    }, releaseId),
    (error) => error instanceof Error && error.retryable === true && /five-light homepage/u.test(error.message),
  );
});

test("release evidence requires a completed administrator password check", () => {
  for (const adminAuth of [undefined, { status: 503, error: "服务暂时不可用，请稍后重试。" }]) {
    assert.throws(
      () => validateReleaseEvidence({ ...evidence, adminAuth }, releaseId),
      /compatible administrator password check/u,
    );
  }
});


test("edge propagation responses are retried without retrying authorization failures", () => {
  for (const status of [404, 408, 421, 425, 500, 502, 503, 504]) {
    assert.equal(isTransientSmokeStatus(status), true);
  }
  for (const status of [undefined, 400, 401, 403, 405, 429]) {
    assert.equal(isTransientSmokeStatus(status), false);
  }
});

test("administrator authentication runs once after retryable release checks settle", async () => {
  let smokeCalls = 0;
  let authCalls = 0;
  const sleeps = [];
  const serviceEvidence = {
    app: "arts-robotics-ai-assistant",
    ready: true,
    releaseId,
    oaPublicStatus: "connected",
    provider: "workers-ai",
    model: "test-model",
    sources: 1,
  };
  const result = await smokeCloudflare("https://chat.example.com", {
    attempts: 3,
    releaseId,
    smokeAttempt: async () => {
      smokeCalls += 1;
      if (smokeCalls < 3) throw Object.assign(new Error("edge pending"), { status: 503 });
      return serviceEvidence;
    },
    verifyAdmin: async () => {
      authCalls += 1;
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });
  assert.equal(smokeCalls, 3);
  assert.equal(authCalls, 1);
  assert.deepEqual(sleeps, [1_500, 3_000]);
  assert.deepEqual(result, { ...serviceEvidence, adminKdfCompatible: true });
});

test("the administrator-only production smoke validates the exact origin once", async () => {
  const origins = [];
  const result = await smokeAdminAuthentication("https://chat.omindos.ai", {
    verifyAdmin: async (origin) => origins.push(origin),
  });
  assert.deepEqual(origins, ["https://chat.omindos.ai"]);
  assert.deepEqual(result, { adminKdfCompatible: true });
  await assert.rejects(
    smokeAdminAuthentication("http://chat.omindos.ai", { verifyAdmin: async () => {} }),
    /exact HTTPS origin/u,
  );
});

test("administrator probes retry only transient failures and never retry a 429", async () => {
  let calls = 0;
  const sleeps = [];
  await smokeAdminAuthentication("https://chat.omindos.ai", {
    verifyAdmin: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("edge pending"), { status: 503 });
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1_500]);

  let rateLimitedCalls = 0;
  await assert.rejects(
    smokeAdminAuthentication("https://chat.omindos.ai", {
      verifyAdmin: async () => {
        rateLimitedCalls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
      sleepImpl: async () => assert.fail("429 must not sleep or retry"),
    }),
    /rate limited/u,
  );
  assert.equal(rateLimitedCalls, 1);
});

test("the saved administrator password is consumed, verified, and not returned", async () => {
  const password = "saved-administrator-password";
  const environment = { CHAT_ADMIN_PASSWORD: password };
  const calls = [];
  const result = await smokeSavedAdminAuthentication("https://chat.omindos.ai", {
    environment,
    logoutAttempts: 1,
    verifyAdmin: async (origin, suppliedPassword) => calls.push({ origin, suppliedPassword }),
  });
  assert.deepEqual(calls, [{ origin: "https://chat.omindos.ai", suppliedPassword: password }]);
  assert.equal("CHAT_ADMIN_PASSWORD" in environment, false);
  assert.deepEqual(result, { adminPasswordVerified: true, smokeSessionRevoked: true });
  assert.equal(JSON.stringify(result).includes(password), false);
});

test("saved-password smoke logs in once and retries logout with the same session", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const password = "saved-administrator-password";
  const token = "b".repeat(64);
  const calls = [];
  let logoutCalls = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (url.endsWith("/api/auth/login")) {
      return new Response(JSON.stringify({ signedIn: true }), {
        status: 200,
        headers: {
          ...headers,
          "Set-Cookie": `__Host-ma-session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`,
        },
      });
    }
    logoutCalls += 1;
    return new Response(JSON.stringify({ saved: true }), {
      status: logoutCalls === 1 ? 503 : 200,
      headers,
    });
  };
  const sleeps = [];
  const result = await smokeSavedAdminAuthentication("https://chat.omindos.ai", {
    environment: { CHAT_ADMIN_PASSWORD: password },
    logoutAttempts: 2,
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(result, { adminPasswordVerified: true, smokeSessionRevoked: true });
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/logout")).length, 2);
  assert.ok(calls.filter((call) => call.url.endsWith("/api/auth/logout")).every(
    (call) => call.options.headers.Cookie === `__Host-ma-session=${token}`,
  ));
  assert.deepEqual(sleeps, [1_500]);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("saved-password smoke revokes its session even when login response validation fails", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const token = "c".repeat(64);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (url.endsWith("/api/auth/login")) {
      return new Response(JSON.stringify({ signedIn: false }), {
        status: 200,
        headers: {
          ...headers,
          "Set-Cookie": `__Host-ma-session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`,
        },
      });
    }
    return new Response(JSON.stringify({ saved: true }), { status: 200, headers });
  };
  await assert.rejects(
    smokeSavedAdminAuthentication("https://chat.omindos.ai", {
      environment: { CHAT_ADMIN_PASSWORD: "saved-administrator-password" },
    }),
    /saved administrator password was not accepted/u,
  );
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/logout")).length, 1);
  assert.equal(calls[1].options.headers.Cookie, `__Host-ma-session=${token}`);
});

test("frontend smoke accepts one deterministic content-hashed script and stylesheet", () => {
  assert.deepEqual(
    frontendAssetPaths(
      '<link rel="stylesheet" href="/assets/styles-0123456789abcdef.css"><script type="module" src="/assets/app-fedcba9876543210.js"></script>',
    ),
    [
      {
        pathname: "/assets/app-fedcba9876543210.js",
        hash: "fedcba9876543210",
        mediaType: "javascript",
      },
      {
        pathname: "/assets/styles-0123456789abcdef.css",
        hash: "0123456789abcdef",
        mediaType: "css",
      },
    ],
  );
  assert.throws(() => frontendAssetPaths("<main>stale shell</main>"), /does not reference/u);
  assert.throws(
    () => frontendAssetPaths(
      '<script src="/assets/app-0123456789abcdef.js"></script><script src="/assets/app-fedcba9876543210.js"></script><link rel="stylesheet" href="/assets/styles-0123456789abcdef.css">',
    ),
    /does not reference/u,
  );
});
