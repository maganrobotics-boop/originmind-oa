import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { handleRequest } from "../src/app.mjs";
import { fallbackAnswer } from "../src/knowledge.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
class TestNode {
  constructor(tag = "#text", text = "") { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes.map((n) => n instanceof TestNode ? n : new TestNode("#text", String(n)))); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
}
const document = { createElement: (tag) => new TestNode(tag), createTextNode: (text) => new TestNode("#text", text) };
const api = runInNewContext(`
  ${section("function cleanPublicChatText", "function knowledgeSuggestionsFromPayload")}
  ${section("function element(", "function icon(")}
  ${section("function referenceSectionStart", "function serviceLabel")}
  ({renderAnswerBody, userFacingAnswer});
`, { document, Node: TestNode });
const nodes = (root, tag) => [...(root.tag === tag ? [root] : []), ...root.children.flatMap((c) => nodes(c, tag))];
const raw = "# 科研方向介绍\n> 版本：V1.0\n> 更新时间：2026年9月\n> 适用范围：宣传\n\n## 一、自主移动\n\n**重点**是定位与导航。\n\n## 二、智能操作\n\n通过反馈完成操作。";

test("browser and Worker use identical answer-presentation rules", async () => {
  const module = await readFile(new URL("../src/answer-presentation.mjs", import.meta.url), "utf8");
  const expected = module.replace('import { protectAnswerTechnicalText } from "./answer-math.mjs";\n', "").replaceAll("export function ", "function ").trim();
  assert.equal(section("// BEGIN SHARED ANSWER PRESENTATION", "// END SHARED ANSWER PRESENTATION")
    .replace("// BEGIN SHARED ANSWER PRESENTATION", "").trim(), expected);
});

test("restored screenshot answer renders real headings rather than raw hash signs", () => {
  const old = `知识库中与这个问题直接相关的内容包括：\n\n- ${raw.replace(/\s+/gu, " ")}`;
  const text = api.userFacingAnswer(old);
  const rendered = api.renderAnswerBody(text);
  assert.doesNotMatch(rendered.textContent, /#|版本|更新时间|适用范围|科研方向介绍|知识库中/u);
  assert.match(rendered.textContent, /定位与导航/u);
  assert.ok(nodes(rendered, "h4").length >= 1);
  assert.equal(nodes(rendered, "strong")[0].textContent, "重点");
});

test("cleaned fallback retains paragraphs, subheadings and substantive content", () => {
  const answer = fallbackAnswer([{ title: "科研方向介绍", body: raw }, { title: "同一资料", body: raw }]);
  assert.equal((answer.match(/定位与导航/gu) || []).length, 1);
  assert.match(answer, /## 一、自主移动\n\n\*\*重点\*\*/u);
  assert.doesNotMatch(answer, /版本|更新时间|适用范围|知识库中|^- #/mu);
  assert.doesNotMatch(fallbackAnswer([]), /提交咨询/u);
});

for (const mode of ["ai", "retrieval"]) {
  test(`${mode} response hides metadata while preserving source binding and model grounding`, async (t) => {
    const ORIGIN = "https://chat.omindos.ai";
    let prompt = "";
    const env = {
      DB: new D1DatabaseAdapter(), APP_ORIGIN: ORIGIN,
      ADMIN_EMAIL: "owner@example.test", APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
      RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
      PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43), RELEASE_ID: `${"a".repeat(40)}-1`,
      AI: { run: async (_model, input) => {
        prompt = input.messages[0].content;
        if (mode === "retrieval") throw Error("model unavailable");
        return { response: "来源：科研方向介绍.pdf\n\n根据《科研方向介绍》，**重点**是定位与导航。[1]" };
      } },
    };
    t.after(() => env.DB.close());
    const response = await handleRequest(new Request(`${ORIGIN}/api/chat`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.91" },
      body: JSON.stringify({ topic: "research", messages: [{ role: "user", content: "实验室有哪些科研方向？" }] }),
    }), env, {}, { fetch: async () => Response.json({ chunks: [{
      id: "1", title: "科研方向介绍", category: "research", sectionTitle: "", paragraphRef: "第1段",
      excerpt: raw, sourceLabel: "OA 公开知识", updatedAt: "2026-09-17",
    }] }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mode, mode);
    assert.match(result.answer, /定位与导航/u);
    assert.doesNotMatch(result.answer, /来源|版本|更新时间|适用范围|科研方向介绍|知识库中|\[1\]/u);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].title, "科研方向介绍");
    assert.match(prompt, /每个有资料依据的具体事实后必须紧跟 \[1\]/u);
    assert.doesNotMatch(prompt, /> 版本：V1.0/u);
  });
}
