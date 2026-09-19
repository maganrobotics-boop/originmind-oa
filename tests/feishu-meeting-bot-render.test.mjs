import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('meeting bot uses reactive state, not a render-time ref, for frozen materials', () => {
  const source = readFileSync(new URL('../components/knowledge/oa-meeting-bot.tsx', import.meta.url), 'utf8');
  assert.match(source, /\[materialsFrozen, setMaterialsFrozen\] = useState\(false\)/u);
  assert.match(source, /setMaterialsFrozen\(true\)/u);
  assert.match(source, /disabled=\{busy \|\| materialsFrozen\}/u);
  assert.doesNotMatch(source.slice(source.indexOf('return <div')), /Boolean\(frozen\.current\)/u);
});
