import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { parseOaResult } from "../chat-cloudflare/src/oa-public.mjs";
import { handleRequest } from "../chat-cloudflare/src/app.mjs";
import { D1DatabaseAdapter } from "../chat-cloudflare/test/d1-adapter.mjs";

const vite = await createServer({ appType: "custom", configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: {middlewareMode:true, hmr:false} });
after(() => vite.close());
const { buildPublicLabAiRetrieveResponse, publicLabAiJson } = await vite.ssrLoadModule("/app/api/public/lab-ai/_lib/response-contract.ts");
const source = await readFile(new URL("../chat-cloudflare/frontend/app.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
class TestNode {
  constructor(tag="#text", text="") { this.tag=tag; this.text=text; this.children=[]; this.attributes={}; }
  append(...nodes) { this.children.push(...nodes.map(n=>n instanceof TestNode ? n : new TestNode("#text", String(n)))); }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  set textContent(value) { this.text=String(value); this.children=[]; }
  get textContent() { return this.text+this.children.map(n=>n.textContent).join(""); }
}
const dom = { createElement:tag=>new TestNode(tag), createTextNode:text=>new TestNode("#text",text) };
const browser = runInNewContext(`${section("function cleanPublicChatText", "function knowledgeSuggestionsFromPayload")}\n${section("function element(", "function icon(")}\n${section("function referenceSectionStart", "function serviceLabel")}\n({renderAnswerBody,userFacingAnswer});`, {document:dom, Node:TestNode});
const nodes=(root,tag)=>[...(root.tag===tag?[root]:[]), ...root.children.flatMap(child=>nodes(child,tag))];
const markdown = "# 示例机器人公司\n\n## 公司介绍\n\n**主要方向**是自主导航与机器人系统。\n\n| 场景 | 用途 |\n| --- | --- |\n| 金属矿 | 巡检 |\n| 工厂 | 运输 |";
const candidate = content => ({id:"private-chunk",itemId:"private-item",revisionId:"private-revision", title:"示例机器人公司", category:"公司介绍",sectionTitle:"",paragraphRef:"第1段", sourceLabel:"公开审核资料",updatedAt:"2026-09-17",content,searchText:"机器人",score:10});

test("actual OA producer preserves Markdown through strict Chat response parsing", async () => {
  const data=buildPublicLabAiRetrieveResponse([candidate(markdown)]);
  assert.equal(data.chunks[0].excerpt, markdown);
  assert.equal(parseOaResult(data)[0].excerpt, markdown);
  const body=browser.renderAnswerBody(browser.userFacingAnswer(data.chunks[0].excerpt));
  assert.equal(nodes(body,"table").length,1);
  assert.equal(nodes(body,"td").length,4);
  assert.equal(nodes(body,"strong")[0].textContent,"主要方向");
  assert.doesNotMatch(body.textContent,/##|\|/u);
  assert.ok(new TextEncoder().encode(await publicLabAiJson(data).text()).length<=16384);
});

test("document newlines, tabs, and technical Unicode are not normalized as labels", () => {
  const technical = "## 公式\r\n\r\n\\[x=α²+β\\]\r\n\r\n```js\r\n\tconst x = 1;\r\n```";
  const result=buildPublicLabAiRetrieveResponse([candidate(technical)]).chunks[0].excerpt;
  assert.equal(result,technical.replace(/\r\n/gu,"\n"));
});

for(const token of [String.raw`\[x=\frac{a}{b}\]`, "```js\nconst a = 1;\nconst b = 2;\n```", "$x_{[1]}$"]) {
  test(`transport truncation does not cut a protected token: ${token.slice(0,10)}`, () => {
    const content="甲".repeat(595)+token+"乙".repeat(100);
    const data=buildPublicLabAiRetrieveResponse([candidate(content)]);
    assert.ok(data.chunks[0].excerpt.length<=600);
    assert.ok(!data.chunks[0].excerpt.includes(token[0]));
    assert.ok(data.chunks[0].excerpt.endsWith("…"));
    assert.equal(parseOaResult(data).length,1);
  });
}

test("sentence boundary selection never reopens an otherwise complete code block", () => {
  const code="```js\n// 保留完整。\nconst a = 1;\n```";
  const content="甲".repeat(520)+code+"乙".repeat(100);
  const excerpt=buildPublicLabAiRetrieveResponse([candidate(content)]).chunks[0].excerpt;
  assert.ok(excerpt.includes(code));
  assert.equal((excerpt.match(/```/gu)||[]).length,2);
});

test("multi-chunk Unicode/byte budgets remain enforced after preserving newlines", async () => {
  const data=buildPublicLabAiRetrieveResponse(Array.from({length:6},(_,i)=>({...candidate("## 章节\n\n"+"🤖自主导航。\n".repeat(300)),id:`c${i}`})));
  assert.equal(parseOaResult(data).length,6);
  assert.ok(data.chunks.reduce((n,c)=>n+c.excerpt.length,0)<=3000);
  assert.ok(new TextEncoder().encode(await publicLabAiJson(data).text()).length<=16384);
});

for (const mode of ["ai", "retrieval", "rejected"]) {
  test(`actual OA producer -> Worker -> renderer (${mode})`, async(t) => {
    const data=buildPublicLabAiRetrieveResponse([candidate(markdown)]);
    const origin="https://chat.omindos.ai";
    let prompt="";
    const env={DB:new D1DatabaseAdapter(),APP_ORIGIN:origin, ADMIN_EMAIL:"owner@example.test",APP_ENCRYPTION_KEY:"e".repeat(48),RATE_LIMIT_HMAC_KEY:"r".repeat(48),PUBLIC_LAB_AI_SERVICE_TOKEN:"A".repeat(43),AI:{run:async(_model,input)=>{
      prompt=input.messages[0].content;
      if(mode==="retrieval") throw Error("provider unavailable");
      return {response: mode==="rejected" ? "没有编号的回答" : markdown+"[1]"};
    }}};
    t.after(()=>env.DB.close());
    const response=await handleRequest(new Request(`${origin}/api/chat`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","CF-Connecting-IP":"203.0.113.93"},body:JSON.stringify({topic:"business",messages:[{role:"user",content:"示例机器人公司简介"}]})}),env,{}, {fetch:async()=>Response.json(data)});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.mode,mode==="ai"?"ai":"retrieval");
    if(mode==="retrieval") assert.equal(result.fallbackReason,"generation_failed");
    if(mode==="rejected") assert.equal(result.fallbackReason,"answer_validation_failed");
    assert.ok(prompt.includes("\\n\\n"));
    const rendered=browser.renderAnswerBody(browser.userFacingAnswer(result.answer));
    assert.equal(nodes(rendered,"table").length,1);
    assert.equal(nodes(rendered,"td").length,4);
    assert.doesNotMatch(rendered.textContent,/##|\|/u);
    assert.equal(result.sources.length,1);
    assert.ok(result.conversationToken);
  });
}
