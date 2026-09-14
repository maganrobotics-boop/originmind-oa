import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function harness() {
  const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const requests = [];
  const sent = [];
  const timers = new Map();
  let nextTimer = 0;
  const api = runInNewContext(`
    const SUGGESTIONS_REFRESH_MS = 60_000;
    const state = {
      section: "academic", networkReady: true,
      service: { knowledgeReady: true, retrievalReady: true },
      suggestions: [], suggestionsLoaded: false, suggestionsLoading: false,
      suggestionsFetchedAt: 0,
    };
    const session = { messages: [], sending: false };
    const sessionFor = () => session;
    let systemStatusController = null;
    let suggestionsRefreshTimer = null;
    let suggestionsRefreshDueAt = 0;
    let suggestionsRefreshPending = false;
    let suggestionsEpoch = 0;
    ${section("function cleanPublicChatText", "const TOPIC_LABELS")}
    ${section("function knowledgeRetrievalReady", "function setSystemLight")}
    ${section("async function dispatchSuggestion", "function renderMessages")}
    ({ state, loadSuggestions, dispatchSuggestion, invalidateSuggestions,
       probe: (active) => { systemStatusController = active ? {} : null; } });
  `, {
    AbortSignal,
    document: { hidden: false },
    window: {
      setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout: (id) => timers.delete(id),
    },
    renderSuggestions() {},
    requestJson: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    dispatchQuestion: (question, section, suggestionToken) => sent.push({ question, section, suggestionToken }),
  });
  const respond = (index, question) => requests[index].resolve({
    suggestions: [{ id: "1", question, updatedAt: "2026-09-14", suggestionToken: "fresh-source-token" }],
    oaPublicStatus: "connected",
  });
  return { ...api, requests, sent, timers, respond };
}

test("a late pre-disconnect response cannot overwrite the recovered suggestions", async () => {
  const h = await harness();
  const old = h.loadSuggestions();
  h.state.networkReady = false;
  h.invalidateSuggestions();
  h.state.networkReady = true;
  const fresh = h.loadSuggestions();
  h.respond(1, "恢复连接后的新话题");
  await fresh;
  h.respond(0, "断网前的旧话题");
  await old;
  assert.deepEqual([...h.state.suggestions], ["恢复连接后的新话题"]);
  assert.equal(h.state.suggestionsLoading, false);
  assert.equal(h.timers.size, 1);
});

test("a clicked suggestion is not sent after invalidation even if it revalidates late", async () => {
  const h = await harness();
  const click = h.dispatchSuggestion("已下架的话题", "academic");
  h.state.networkReady = false;
  h.invalidateSuggestions();
  h.respond(0, "已下架的话题");
  await click;
  assert.deepEqual(h.sent, []);
  assert.deepEqual([...h.state.suggestions], []);
  assert.equal(h.state.suggestionsLoading, false);
  assert.equal(h.timers.size, 0);
});

test("click revalidation sends once only while readiness and the source question remain valid", async () => {
  for (const scenario of ["ready", "probing", "removed", "switched"]) {
    const h = await harness();
    const click = h.dispatchSuggestion("当前知识话题", "academic");
    if (scenario === "probing") h.probe(true);
    if (scenario === "switched") h.state.section = "company";
    h.respond(0, scenario === "removed" ? "另一条话题" : "当前知识话题");
    await click;
    assert.equal(h.sent.length, scenario === "ready" ? 1 : 0, scenario);
    if (scenario === "ready") assert.equal(h.sent[0].suggestionToken, "fresh-source-token");
    assert.equal(h.state.suggestionsLoading, false, scenario);
  }
});
