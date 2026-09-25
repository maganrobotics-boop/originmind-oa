import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const publicRoot = new URL("../public/", import.meta.url);
const index = readFileSync(new URL("index.html", publicRoot), "utf8");
const appPath = index.match(/src="(\/assets\/app-[a-f0-9]+\.js)"/u)[1];
const source = readFileSync(new URL(`.${appPath}`, publicRoot), "utf8");
const contextSource = source.slice(source.indexOf("const NEWBIE_COURSES ="), source.indexOf("function showToast("));
const resetSource = source.slice(source.indexOf("function resetChat("), source.indexOf("function loadHistory("));
function setup(search) {
  const promptInput = { value: "", placeholder: "提问", style: {}, focus() {}, setSelectionRange() {} };
  const context = vm.createContext({ URLSearchParams, promptInput,
    window: { location: { search }, setTimeout() {} }, setTimeout() {},
    heroTitle: {}, heroSubtitle: {}, currentMode: "text", MODE_COPY: { text: ["实验室大模型", "欢迎提问"] },
    activeConversationId: "existing-chat", conversations: [{ id: "existing-chat", turns: [{ role: "user", text: "之前的真实问题" }] }],
    messageList: { innerHTML: "old chat" }, fileInput: { value: "" },
    body: { classList: { remove() {} } }, attachmentChip: { classList: { remove() {} } },
    persistConversations() {}, renderRecentConversations() {}, updateSendState() {}, autoResize() {},
    fetch() { throw Error("Opening a tutor link must never send an API request"); },
  });
  vm.runInContext(contextSource + resetSource, context);
  return { context, run: code => vm.runInContext(code, context), promptInput };
}

test("all seven courses prepare distinct public goals, steps and evidence, without sending", () => {
  for (const id of ["registration", "toolkit", "git-basics", "python-basics", "ros2-simulation", "mini-project", "graduation"]) {
    const app = setup(`?ta=1&course=${id}`);
    app.run("launchPromptFromUrl()");
    assert.match(app.promptInput.value, /本关目标：[\s\S]+学习任务：[\s\S]+验收与提交要求：/u);
    assert.ok(app.promptInput.value.length < 4000);
    assert.equal(app.run("activeConversationId"), "");
    assert.equal(app.run("conversations.length"), 1);
    assert.equal(app.run("conversations[0].turns[0].text"), "之前的真实问题");
    assert.ok(app.promptInput.value.includes(app.run(`NEWBIE_COURSES[${JSON.stringify(id)}].deliverables[0]`)));
    assert.ok(!app.promptInput.value.includes("之前的真实问题"));
  }
});

test("Python hint includes the selected question and numeric acceptance standard", () => {
  const app = setup("?ta=1&course=python-basics&hint=0&email=private@example.com&evidence=secret");
  app.run("launchPromptFromUrl()");
  assert.match(app.promptInput.value, /0\.001/u);
  assert.ok(app.promptInput.value.endsWith(app.run("NEWBIE_COURSES['python-basics'].taPrompts[0]")));
  assert.doesNotMatch(app.promptInput.value, /private@example|secret/u);
});

test("unknown course and prototype keys cannot invent course context or clear history", () => {
  for (const query of ["?ta=1&course=__proto__", "?ta=1&course=constructor", "?ta=1&course=unknown", "?course=python-basics"]) {
    const app = setup(query); app.run("launchPromptFromUrl()");
    assert.equal(app.promptInput.value, "");
    assert.equal(app.run("activeConversationId"), "existing-chat");
  }
});

test("legacy TA prompts open with existing history; oversized prompts are ignored", () => {
  const app = setup("?ta=1&prompt=" + encodeURIComponent("帮我排查命令错误"));
  app.run("launchPromptFromUrl()");
  assert.equal(app.promptInput.value, "帮我排查命令错误");
  assert.equal(app.run("conversations.length"), 1);
  const long = setup("?ta=1&prompt=" + "x".repeat(501));
  long.run("launchPromptFromUrl()");
  assert.equal(long.run("activeConversationId"), "existing-chat");
});

test("all published v2 lessons link to their own tutor context", () => {
  for (const id of ["registration", "toolkit", "git-basics", "python-basics", "ros2-simulation", "mini-project", "graduation"]) {
    const path = id === "python-basics" ? "assets/newbie-python-v2/index.html" : `assets/newbie-course-v2/${id}/index.html`;
    assert.ok(readFileSync(new URL(path, publicRoot), "utf8").includes(`/?ta=1&amp;course=${id}`), id);
  }
});
