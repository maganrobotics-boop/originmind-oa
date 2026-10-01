import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Static regression guards only; authenticated production layout still needs
// verification against the server revision before this patch is released.
const css = readFileSync(new URL('../components/knowledge/oa-conversations.css', import.meta.url), 'utf8');
const marker = '/* Compact OA chat header (2026-09-28):';
const start = css.indexOf(marker);
assert.notEqual(start, -1, 'Compact-header overrides must exist');
const patch = css.slice(start).replace(/\/\*[\s\S]*?\*\//gu, '');
const rules = [...patch.matchAll(/([^{}]+)\{([^{}]*)\}/gu)];
function ruleFor(selector) {
  const rule = rules.find(([, selectors]) => selectors.split(',').some(value => value.trim() === selector));
  assert.ok(rule, `Missing selector: ${selector}`);
  return rule[2];
}
const scope = '.oa-app.oa-workspace.oa-chat-open';

test('every override is scoped to the active OA chat view', () => {
  assert.ok(rules.length >= 6);
  for (const [, selectors] of rules) {
    for (const selector of selectors.split(',')) {
      assert.ok(selector.trim().startsWith(`${scope} `), selector);
    }
  }
});

test('the topbar new-chat control is neutral and icon-only, with a 44px target', () => {
  const rule = ruleFor(`${scope} .topbar .oa-sidebar-new-chat`);
  for (const declaration of ['background:transparent;', 'border:0;', 'box-shadow:none;', 'font-size:0;', 'width:44px;', 'min-height:44px;']) {
    assert.ok(rule.includes(declaration), declaration);
  }
  assert.ok(ruleFor(`${scope} .topbar .oa-sidebar-new-chat:hover`).includes('background:transparent;'));
  assert.ok(ruleFor(`${scope} .topbar .oa-sidebar-new-chat:active`).includes('background:transparent;'));
  assert.match(ruleFor(`${scope} .topbar .oa-sidebar-new-chat > svg`), /width:24px;[\s\S]*height:24px;/u);
});

test('keyboard focus remains visible and the action is not hidden from accessibility', () => {
  assert.match(ruleFor(`${scope} .topbar .oa-sidebar-new-chat:focus-visible`), /outline:2px solid currentColor;/u);
  assert.doesNotMatch(patch, /display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none/u);
});

test('header height and shell spacing are compact without negative offsets', () => {
  const header = ruleFor(`${scope} .topbar`);
  assert.match(header, /flex:0 0 48px;/u);
  assert.match(header, /min-height:48px;/u);
  assert.match(ruleFor(`${scope} > .main-shell`), /row-gap:0;/u);
  assert.doesNotMatch(patch, /(?:margin|top|translate)[^:]*:\s*-\d/u);
});

test('chat starts 8px below the header and removes inherited wrapper gaps', () => {
  const messages = ruleFor(`${scope} .oa-shared-chat .oa-chat-messages`);
  assert.match(messages, /padding-block-start:8px;/u);
  for (const selector of ['.oa-knowledge-pane', '.knowledge-view[data-section="ask"]', '.knowledge-tabs', '.oa-chat-tab']) {
    assert.match(ruleFor(`${scope} ${selector}`), /margin-block-start:0;[\s\S]*padding-block-start:0;[\s\S]*row-gap:0;/u);
  }
});

test('bottom navigation, composer, viewport and safe-area rules are untouched', () => {
  assert.doesNotMatch(patch, /composer|bottom-nav|100(?:d|s|l)?vh|safe-area-inset|position\s*:\s*(?:fixed|absolute)/u);
});
