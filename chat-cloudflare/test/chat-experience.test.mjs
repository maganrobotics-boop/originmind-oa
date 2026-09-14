import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
class TestNode {
  constructor(tag = "#text", text = "") { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes.map((node) => node instanceof TestNode ? node : new TestNode("#text", String(node)))); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
}
const document = { createElement: (tag) => new TestNode(tag), createTextNode: (text) => new TestNode("#text", text) };
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const api = runInNewContext(`
  ${section("function cleanPublicChatText", "function knowledgeSuggestionsFromPayload")}
  ${section("function element(", "function icon(")}
  ${section("function referenceSectionStart", "function serviceLabel")}
  ({ CHAT_HISTORY_KEY, CHAT_HISTORY_TTL_MS, CHAT_TOKEN_TTL_MS,
     readChatHistory, writeChatHistory, chatHistorySnapshot, renderAnswerBody, userFacingAnswer });
`, { document, Node: TestNode });
function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
const now = 1_789_369_200_000;
function session(extra = {}) {
  return { messages: [{ role: "user", content: "机器人有哪些能力？" }, { role: "assistant", content: "支持**自主巡检**。" }],
    draft: "进一步说明", conversationToken: "opaque-server-token", tokenSavedAt: now,
    sending: false, scrollTop: 123, stickToEnd: false, ...extra };
}
function nodes(root, tag) { return [...(root.tag === tag ? [root] : []), ...root.children.flatMap((child) => nodes(child, tag))]; }

test("reload restores isolated topic messages, draft and fresh signed context without persisting unrelated state", () => {
  const store = storage();
  api.writeChatHistory(store, "technology", session({ contact: "do not save", apiKey: "do not save", error: "transient" }), now);
  api.writeChatHistory(store, "company", session({ draft: "产品问题" }), now);
  const restored = api.readChatHistory(store, "technology", now + 1000);
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].content, "支持**自主巡检**。");
  assert.equal(restored.draft, "进一步说明");
  assert.equal(restored.conversationToken, "opaque-server-token");
  assert.equal(restored.scrollTop, 123);
  assert.equal(restored.stickToEnd, false);
  assert.equal(restored.sending, false);
  assert.equal(api.readChatHistory(store, "company", now + 1000).draft, "产品问题");
  assert.equal(api.readChatHistory(store, "association", now + 1000), null);
  assert.doesNotMatch(store.getItem(api.CHAT_HISTORY_KEY + "technology"), /contact|apiKey|transient/u);
});

test("interrupted requests restore as an unsent draft without a duplicate user turn or automatic send", () => {
  const store = storage();
  const pending = session({ draft: "", sending: true });
  pending.messages.push({ role: "user", content: "这个方案的局限是什么？" });
  api.writeChatHistory(store, "technology", pending, now);
  const restored = api.readChatHistory(store, "technology", now + 1000);
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.draft, "这个方案的局限是什么？");
  assert.equal(restored.sending, false);
  assert.match(restored.notice, /未完成/u);
});

test("clearing a conversation removes only that topic's stored record", () => {
  const store = storage();
  for (const topic of ["technology", "company"]) api.writeChatHistory(store, topic, session(), now);
  api.writeChatHistory(store, "technology", session({ messages: [], draft: "", conversationToken: "" }), now + 1);
  assert.equal(api.readChatHistory(store, "technology", now + 2), null);
  assert.equal(api.readChatHistory(store, "company", now + 2).messages.length, 2);
});

test("expired signed context is discarded while visible history survives until its retention limit", () => {
  const store = storage();
  api.writeChatHistory(store, "technology", session(), now);
  const restored = api.readChatHistory(store, "technology", now + api.CHAT_TOKEN_TTL_MS);
  assert.equal(restored.conversationToken, "");
  assert.equal(restored.messages.length, 2);
  assert.equal(api.readChatHistory(store, "technology", now + api.CHAT_HISTORY_TTL_MS), null);
  assert.equal(store.values.size, 0);
});

test("corrupt, wrong-topic and oversized histories cannot break startup", () => {
  for (const value of ["{broken", "x".repeat(800_001), JSON.stringify({ version: 2 }),
    JSON.stringify(api.chatHistorySnapshot("company", session(), now)),
    JSON.stringify(api.chatHistorySnapshot("technology", session(), now + 1))]) {
    const store = storage();
    store.setItem(api.CHAT_HISTORY_KEY + "technology", value);
    assert.equal(api.readChatHistory(store, "technology", now), null);
    assert.equal(store.values.size, 0);
  }
  const blocked = { getItem() { throw Error("disabled"); }, setItem() { throw Error("quota"); }, removeItem() { throw Error("disabled"); } };
  assert.equal(api.readChatHistory(blocked, "technology", now), null);
  assert.equal(api.writeChatHistory(blocked, "technology", session(), now), false);
});

test("large histories retain recent bounded messages and remove visible reference sections again on reload", () => {
  const store = storage();
  const messages = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "字".repeat(2000) }));
  api.writeChatHistory(store, "technology", session({ messages }), now);
  const restored = api.readChatHistory(store, "technology", now);
  assert.ok(restored.messages.length <= 40);
  assert.ok(restored.messages.reduce((sum, message) => sum + message.content.length, 0) <= 80_000);
  assert.equal(restored.messages[0].role, "user");
  messages.splice(0, messages.length, { role: "user", content: "请介绍" }, { role: "assistant", content: "公开技术成果。[1]\n\n参考文献：\n[1] 来源标题" });
  api.writeChatHistory(store, "technology", session({ messages }), now);
  assert.equal(api.readChatHistory(store, "technology", now).messages[1].content, "公开技术成果。");
});

test("answers render paragraphs, emphasis, lists and accessible tables using semantic nodes", () => {
  const answer = "**建议先试点。**\n\n1. 明确场景\n2. 验证结果\n\n| 方案 | 优点 |\n| --- | --- |\n| 轮式 | 易维护 |\n| 四足 | 越障 |\n\n补充说明。";
  const body = api.renderAnswerBody(answer);
  assert.equal(nodes(body, "strong")[0].textContent, "建议先试点。");
  assert.equal(nodes(body, "ol").length, 1);
  assert.equal(nodes(body, "li").length, 2);
  assert.equal(nodes(body, "th").length, 2);
  assert.equal(nodes(body, "td").length, 4);
  assert.equal(nodes(body, "th")[0].attributes.scope, "col");
  assert.equal(nodes(body, "table").length, 1);
  const wrap = nodes(body, "div").find((node) => node.className === "answer-table-scroll");
  assert.equal(wrap.attributes.tabindex, "0");
  assert.equal(nodes(body, "p").at(-1).textContent, "补充说明。");
});

test("markup cannot create executable HTML, image loads or links", () => {
  const answer = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n![photo](https://example.test/tracker)\n\n**<svg onload=alert(1)>**';
  const body = api.renderAnswerBody(answer);
  for (const tag of ["script", "img", "svg", "iframe", "a"]) assert.equal(nodes(body, tag).length, 0, tag);
  assert.match(body.textContent, /<script>alert\(1\)<\/script>/u);
  assert.match(nodes(body, "strong")[0].textContent, /<svg/u);
});

test("code, escaped pipes and malformed tables retain their text", () => {
  const body = api.renderAnswerBody('```cpp\nif (a < b) {}\n```\n\n| 参数 | 值 |\n| --- | --- |\n| `a|b` | x\\|y |\n\n| 不完整 | 表格 |\n| 单列 |');
  assert.equal(nodes(body, "pre")[0].textContent, "if (a < b) {}");
  assert.equal(nodes(body, "td")[0].textContent, "a|b");
  assert.equal(nodes(body, "td")[1].textContent, "x|y");
  assert.match(body.textContent, /不完整/u);
  assert.match(body.textContent, /单列/u);
});

function publicAppHarness(store, { failChat = false } = {}) {
  const all = [];
  class AppNode extends TestNode {
    constructor(tag) {
      super(tag); all.push(this); this.listeners = {}; this.value = "";
      this.scrollTop = 0; this.scrollHeight = 500; this.clientHeight = 300;
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    fire(name) { for (const callback of this.listeners[name] || []) callback({ target: this, currentTarget: this, preventDefault() {} }); }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    querySelectorAll() { const result = []; result.item = () => null; return result; }
    contains(target) { return this === target || this.children.some((node) => node.contains?.(target)); }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const root = new AppNode("div"); root.id = "app";
  const doc = new AppNode("document");
  doc.documentElement = new AppNode("html"); doc.body = new AppNode("body");
  doc.createElement = (tag) => new AppNode(tag);
  doc.createTextNode = (text) => new TestNode("#text", text);
  doc.getElementById = (id) => all.find((node) => node.id === id);
  const win = new AppNode("window");
  const timers = new Map(); let nextTimer = 0;
  Object.assign(win, {
    localStorage: store, location: { pathname: "/technology", origin: "https://chat.omindos.ai" },
    innerHeight: 800, confirm: () => true,
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { callback(); return 0; }, cancelAnimationFrame() {},
    history: { pushState(_state, _unused, pathname) { win.location.pathname = pathname; } },
  });
  const requests = [];
  runInNewContext(source, {
    Node: TestNode, HTMLElement: AppNode, document: doc, window: win,
    TextDecoder, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal, crypto,
    navigator: { onLine: true },
    fetch: async (url, options) => {
      requests.push({ url, body: options?.body });
      if (url === "/api/chat") {
        if (failChat) throw new Error("offline");
        return Response.json({ answer: "**可以试点。**\n\n- 明确目标\n- 验证结果", conversationToken: "new-server-token", oaPublicStatus: "connected" });
      }
      return Response.json({ suggestions: [], knowledgeReady: false });
    },
  });
  return { all, root, win, requests, input: () => doc.getElementById("question") };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the complete UI restores on startup, saves drafts before pagehide and clears persisted records", async () => {
  const store = storage();
  api.writeChatHistory(store, "technology", session({ tokenSavedAt: Date.now() }), Date.now());
  const app = publicAppHarness(store);
  await settle();
  assert.equal(app.input().value, "进一步说明");
  assert.match(app.root.textContent, /自主巡检/u);
  assert.equal(app.requests.filter((request) => request.url === "/api/chat").length, 0);
  app.input().value = "刷新前未提交的草稿";
  app.input().fire("input");
  app.win.fire("pagehide");
  const refreshed = publicAppHarness(store);
  await settle();
  assert.equal(refreshed.input().value, "刷新前未提交的草稿");
  refreshed.all.find((node) => node.className === "drawer-action drawer-reset").fire("click");
  assert.equal(api.readChatHistory(store, "technology"), null);
  assert.doesNotMatch(refreshed.root.textContent, /自主巡检/u);
});

test("the complete UI persists completed answers and retains failed questions as drafts", async () => {
  for (const failChat of [false, true]) {
    const store = storage(); const app = publicAppHarness(store, { failChat });
    await settle();
    app.input().value = "请介绍技术方案"; app.input().fire("input");
    app.all.find((node) => node.tag === "form" && node.className === "composer").fire("submit");
    await settle(); await settle();
    const restored = api.readChatHistory(store, "technology");
    assert.equal(restored.sending, false);
    if (failChat) {
      assert.equal(restored.messages.length, 0);
      assert.equal(restored.draft, "请介绍技术方案");
    } else {
      assert.equal(restored.messages.length, 2);
      assert.equal(restored.conversationToken, "new-server-token");
      assert.equal(nodes(app.root, "strong").some((node) => node.textContent === "可以试点。"), true);
    }
  }
});
