import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFile(path.join(root, name), 'utf8');
const source = await read('chat-cloudflare/frontend/app.js');
export function section(source, start, end) {
  const first = source.indexOf(start); const last = source.indexOf(end, first + start.length);
  if (first < 0 || last <= first || source.indexOf(start, first + start.length) >= 0) throw new Error(`Shared Chat section is ambiguous: ${start}`);
  return source.slice(first, last);
}
const mathName = (await readdir(path.join(root, 'chat-cloudflare/public/assets'))).find(name => /^katex-[a-f0-9]{16}\.mjs$/u.test(name));
if (!mathName) throw new Error('The verified Chat math asset is missing');
const mathBytes = await readFile(path.join(root, 'chat-cloudflare/public/assets', mathName));
if (!mathName.includes(createHash('sha256').update(mathBytes).digest('hex').slice(0, 16))) throw new Error('Chat math asset digest mismatch');
const renderer = [
  section(source, 'function cleanPublicChatText', 'function knowledgeSuggestionsFromPayload'),
  section(source, 'function element(', 'function icon('),
  section(source, 'function referenceSectionStart', 'function serviceLabel'),
].join('\n').replaceAll('__KATEX_ASSET__', `/assets/${mathName}`).replaceAll('import(url)', 'import(/* @vite-ignore */ url)');
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
console.log('OA renderer, math asset and scoped styles synchronized with Chat.');
