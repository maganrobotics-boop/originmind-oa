// Update existing test harnesses to exercise the bundled helpers and exact new build bytes.
import { readFile, writeFile } from 'node:fs/promises';
function once(text, before, after) {
  if (text.split(before).length !== 2) throw Error(`Test anchor missing or duplicated: ${before}`);
  return text.replace(before, after);
}
async function update(file, marker, transform) {
  const path = new URL(`../test/${file}`, import.meta.url);
  const source = await readFile(path, 'utf8');
  if (!source.includes(marker)) await writeFile(path, transform(source));
}
await update('answer-formatting.test.mjs', 'actions\\.append\\(copy, copyLink, shareLink\\)', text => once(text,
  '/actions\\.append\\(copy\\)/u', '/actions\\.append\\(copy, copyLink, shareLink\\)/u'));
await update('chat-experience.test.mjs', 'const messageActions =', text => {
  text = once(text, 'const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");',
    'const messageActions = await readFile(new URL("../frontend/message-actions.js", import.meta.url), "utf8");\nconst source = messageActions + "\\n" + await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");');
  return once(text, '  doc.createElement = (tag) => new AppNode(tag);',
    '  doc.createElement = (tag) => new AppNode(tag);\n  doc.createElementNS = (_namespace, tag) => new AppNode(tag);');
});
await update('public-assets.test.mjs', 'baseStyle, math, messageActions', text => {
  text = once(text, 'const [template, appSource, style, math]', 'const [template, appSource, baseStyle, math, messageActions, actionStyle]');
  text = once(text, '    readFile(path.join(root, "node_modules/katex/dist/katex.mjs")),',
    '    readFile(path.join(root, "node_modules/katex/dist/katex.mjs")),\n    readFile(path.join(frontendDir, "message-actions.js"), "utf8"),\n    readFile(path.join(frontendDir, "message-actions.css")),');
  return once(text, '  const app = Buffer.from(appSource.toString("utf8").replace("__KATEX_ASSET__", `/assets/${mathName}`));',
    '  const app = Buffer.from(`${messageActions}\\n${appSource.toString("utf8").replace("__KATEX_ASSET__", `/assets/${mathName}`)}\\nvoid openIncomingSharedAnswer();\\n`);\n  const style = Buffer.concat([baseStyle, Buffer.from("\\n"), actionStyle]);');
});
console.log('Existing renderer/history/build tests include message actions without removing assertions.');
