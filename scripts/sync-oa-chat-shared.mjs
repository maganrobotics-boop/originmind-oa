import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFile(path.join(root, name), 'utf8');
const sourcePath = path.join(root, 'chat-cloudflare/frontend/app.js');
const options = { allowJs: true, noResolve: true, noLib: true, target: ts.ScriptTarget.ESNext };
const program = ts.createProgram([sourcePath], options);
const source = program.getSourceFile(sourcePath);
if (!source || source.parseDiagnostics.length) throw new Error('Chat frontend could not be parsed');
const checker = program.getTypeChecker();
const declarations = new Map();
const named = new Map();
for (const statement of source.statements) {
  const names = ts.isFunctionDeclaration(statement) && statement.name ? [statement.name]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(declaration => declaration.name).filter(ts.isIdentifier) : [];
  for (const name of names) {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol || named.has(name.text)) throw new Error(`Ambiguous Chat binding: ${name.text}`);
    declarations.set(symbol, statement); named.set(name.text, statement);
  }
}
const selected = new Set();
const pending = ['renderAnswerBody', 'userFacingAnswer'].map(name => {
  const declaration = named.get(name);
  if (!declaration) throw new Error(`Shared renderer export is missing: ${name}`);
  return declaration;
});
while (pending.length) {
  const statement = pending.pop();
  if (selected.has(statement)) continue;
  selected.add(statement);
  const visit = node => {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      const dependency = declarations.get(symbol);
      if (dependency && !selected.has(dependency)) pending.push(dependency);
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
}
for (const name of ['state', 'api', 'readChatHistory', 'persistConversation', 'saveChatHistory', 'CHAT_HISTORY_KEY', 'CHAT_CONVERSATIONS_KEY']) {
  if (named.has(name) && selected.has(named.get(name))) throw new Error(`Answer renderer must not import public conversation state: ${name}`);
}
const mathNames = (await readdir(path.join(root, 'chat-cloudflare/public/assets'))).filter(name => /^katex-[a-f0-9]{16}\.mjs$/u.test(name));
if (mathNames.length !== 1) throw new Error('Expected exactly one verified Chat math asset');
const mathName = mathNames[0];
const mathBytes = await readFile(path.join(root, 'chat-cloudflare/public/assets', mathName));
if (!mathName.includes(createHash('sha256').update(mathBytes).digest('hex').slice(0, 16))) throw new Error('Chat math asset digest mismatch');
const renderer = source.statements.filter(statement => selected.has(statement)).map(statement => statement.getFullText(source)).join('\n')
  .replaceAll('__KATEX_ASSET__', `/assets/${mathName}`).replaceAll('import(url)', 'import(/* @vite-ignore */ url)');
if (/\b(?:localStorage|sessionStorage)\b/u.test(renderer)) throw new Error('Shared answer renderer must not access conversation storage');
await writeFile(path.join(root, 'lib/oa-chat-renderer.mjs'), `/* Generated from Chat's DOM-safe answer renderer; do not edit. */\n/* eslint-disable */\n${renderer}\nexport { renderAnswerBody, userFacingAnswer };\n`);
await writeFile(path.join(root, 'lib/oa-chat-renderer.d.mts'), 'export function renderAnswerBody(answer: string): HTMLElement;\nexport function userFacingAnswer(answer: string): string;\n');
await mkdir(path.join(root, 'public/assets'), { recursive: true });
await copyFile(path.join(root, 'chat-cloudflare/public/assets', mathName), path.join(root, 'public/assets', mathName));
await copyFile(path.join(root, 'chat-cloudflare/public/LICENSES.md'), path.join(root, 'public/assets/oa-chat-LICENSES.md'));

const css = postcss.parse(await read('chat-cloudflare/frontend/styles.css'));
css.walkRules(rule => {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && /keyframes$/u.test(parent.name)) return;
  }
  rule.selectors = rule.selectors.map(selector => {
    const value = selector.trim();
    if (/^(?::root|html|body)(?=$|[\s.#[:])/u.test(value)) return value.replace(/^(?::root|html|body)/u, '.oa-shared-chat');
    return `.oa-shared-chat ${value}`;
  });
});
await writeFile(path.join(root, 'components/knowledge/shared-chat.generated.css'), `/* Generated and scoped from the same Chat stylesheet. */\n${css.toString()}\n`);
console.log(`OA renderer synchronized from ${selected.size} Chat declarations, with local math and scoped styles.`);
