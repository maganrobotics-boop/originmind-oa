import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../lib/oa-chat-renderer.mjs", import.meta.url), "utf8");
const assetPath = source.match(/const KATEX_ASSET = "([^"]+)";/u)?.[1];
const importExpression = "import(`${KATEX_ASSET}${separator}math-load=${answerMathImportVersion++}`)";

test("generated OA renderer loads local math once and preserves math/code pipes in table cells", async () => {
  assert.ok(assetPath, "shared extraction must include the local math asset");
  assert.ok(source.includes(importExpression), "shared extraction must include the loader");
  const mathModule = await import(new URL("../public" + assetPath, import.meta.url));
  let finishLoading;
  const loading = new Promise(resolve => { finishLoading = resolve; });
  const imports = [];
  const document = {
    createElement: tag => ({ tag, innerHTML: "" }),
    querySelectorAll: () => [],
  };
  const api = runInNewContext(source
    .replace(importExpression, "importMathAsset(`${KATEX_ASSET}${separator}math-load=${answerMathImportVersion++}`)")
    .replace("export { renderAnswerBody, userFacingAnswer };", "({ renderAnswerBody, userFacingAnswer });"), {
    document,
    window: { setTimeout },
    importMathAsset: url => { imports.push(url); return loading; },
  });
  const answer = String.raw`关键关系：\(a=\frac{v^2}{r}\)。

\[
A=\begin{bmatrix}1&2\\3&4\end{bmatrix}
\]

| 项目 | 公式 | 代码 |
| --- | --- | --- |
| 范数 | $|x|$ | ` + "`a|b`" + String.raw` |
| 误差 | $e_i^2$ | x\|y |`;
  const pending = api.renderAnswerBody(answer).innerHTML;
  assert.equal((pending.match(/data-math-status="fallback"/gu) || []).length, 4);
  api.renderAnswerBody(answer);
  assert.equal(imports.length, 1, "concurrent answers must reuse the pending loader");
  assert.equal(imports[0], assetPath + "?math-load=0");
  finishLoading(mathModule);
  await new Promise(resolve => setImmediate(resolve));

  const rendered = api.renderAnswerBody(answer).innerHTML;
  assert.equal((rendered.match(/<math\b/gu) || []).length, 4);
  assert.equal((rendered.match(/<td>/gu) || []).length, 6);
  assert.ok(rendered.includes("<code>a|b</code>"));
  assert.ok(rendered.includes("<td>x|y</td>"));
  assert.equal((rendered.match(/data-math-status="fallback"/gu) || []).length, 0);
  assert.equal(imports.length, 1, "completed math loads must be reused");
});
