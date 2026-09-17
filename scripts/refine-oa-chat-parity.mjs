import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

async function refine(path, before, after) {
  const text = await readFile(path, 'utf8');
  if (text.includes(after)) return;
  if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Expected one source anchor in ${path}`);
  await writeFile(path, text.replace(before, after));
}
// Keep status polling in its own rate bucket, not the question budget.
await refine('lib/write-rate-limit.ts', ' | "lab_ai_ask"; limit:', ' | "lab_ai_ask" | "lab_ai_status"; limit:');
// Response.json() is unknown in the Worker typings; reject malformed status payloads.
await refine('components/knowledge/oa-chat-panel.tsx', '        const value = await response.json();', `        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid status response');
        const value = payload as Record<string, unknown>;`);
// Public-facing detail projections intentionally omit revision IDs. Read the
// authenticated authoritative row instead of relying on those optional fields.
const assetPath = 'app/api/knowledge/[id]/assets/[...assetPath]/route.ts';
await refine(assetPath, 'import { getKnowledgeItemDetail, type KnowledgeActor }', 'import { findKnowledgeItem, getKnowledgeItemDetail, type KnowledgeActor }');
await refine(assetPath, '    const requestedRevision = query.get("revision");', '    const requestedRevision = query.get("revision");\n    const currentItem = forChat ? await findKnowledgeItem(safe.id, access.actor) : null;');
await refine(assetPath, '      || detail?.item.status !== "active" || detail.item.activeRevisionId !== requestedRevision\n      || detail.item.currentRevisionId !== requestedRevision)', '      || currentItem?.status !== "active" || currentItem.active_revision_id !== requestedRevision\n      || currentItem.current_revision_id !== requestedRevision)');
await refine('tests/oa-chat-parity.test.mjs', '  assert.match(asset, /detail\\?\\.item.status !== "active"/u);\n  assert.match(asset, /detail.item.activeRevisionId !== requestedRevision/u);', '  assert.match(asset, /findKnowledgeItem\\(safe\\.id, access\\.actor\\)/u);\n  assert.match(asset, /currentItem\\?\\.status !== "active"/u);\n  assert.match(asset, /currentItem\\.active_revision_id !== requestedRevision/u);\n  assert.match(asset, /currentItem\\.current_revision_id !== requestedRevision/u);');
// The public route also uses this helper for follow-up retrieval, before model
// generation. Export and import it rather than dropping that existing binding.
await refine('chat-cloudflare/src/grounded-prompt.mjs', 'function boundedUserMessages(', 'export function boundedUserMessages(');
await refine('chat-cloudflare/src/app.mjs', 'import { buildGroundedChatMessages }', 'import { buildGroundedChatMessages, boundedUserMessages }');
const viewPath = 'components/knowledge/knowledge-view.tsx';
let view = await readFile(viewPath, 'utf8');
view = view.replace('  FileCheck2,\n', '').replace('  Sparkles,\n', '');
await writeFile(viewPath, view);
// The kept-mounted chat wrapper is an ordinary div, not a tabpanel primitive.
// Give it the flex height as well, otherwise all messages collapse to padding.
await refine(viewPath, '<div hidden={visibleTab !== "ask"}><KnowledgeAskPanel /></div>', '<div className="oa-chat-tab" hidden={visibleTab !== "ask"}><KnowledgeAskPanel /></div>');
const cssPath = 'app/oa-workspace.css';
let css = await readFile(cssPath, 'utf8');
if (!css.includes('/* Verified chat-wrapper and composer integration */')) {
  css += `
/* Verified chat-wrapper and composer integration */
.oa-workspace.oa-chat-open .knowledge-tabs > .oa-chat-tab { flex:1 1 0; min-height:0; height:100%; margin:0; padding:0; }
.oa-workspace.oa-chat-open .topbar-actions > .chat-hub { display:none !important; }
.oa-workspace .oa-shared-chat .oa-chat-composer-area { width:100%; max-width:none; margin:0; padding:12px max(14px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left)); background:#fff; }
.oa-workspace .oa-shared-chat .oa-chat-composer { width:100%; max-width:none; margin:0; min-height:72px; padding:14px 12px 14px 20px; border:1px solid #dedede; border-radius:28px; box-shadow:0 2px 20px #00000008; }
.oa-workspace .oa-shared-chat .oa-chat-composer:focus-within { border-color:#bcbcbc; box-shadow:0 2px 20px #00000008; }
.oa-workspace .oa-shared-chat .oa-chat-composer .send-button { border-radius:50%; box-shadow:none; }
.oa-workspace .oa-shared-chat .oa-chat-composer .send-button::before { content:none; }
@media(max-width:560px) { .oa-workspace .oa-shared-chat .oa-chat-composer { min-height:62px; padding:9px 10px 9px 16px; } }
`;
  await writeFile(cssPath, css);
}
console.log('OA status, image checks, follow-up retrieval and actual-page viewport integration refined.');
execFileSync(process.execPath, ['scripts/build-oa-chat-browser-fixture.mjs'], { stdio: 'inherit' });
