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
// Remove icons left unused after replacing the old chat panel.
const viewPath = 'components/knowledge/knowledge-view.tsx';
let view = await readFile(viewPath, 'utf8');
view = view.replace('  FileCheck2,\n', '').replace('  Sparkles,\n', '');
await writeFile(viewPath, view);
console.log('OA status, image revision checks and the public follow-up retrieval helper refined.');
// This fixture uses the actual integrated components and is preserved as private
// CI evidence. It never contacts a live API while building.
execFileSync(process.execPath, ['scripts/build-oa-chat-browser-fixture.mjs'], { stdio: 'inherit' });
