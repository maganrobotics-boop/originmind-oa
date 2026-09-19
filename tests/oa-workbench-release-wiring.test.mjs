import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const shellPath = fileURLToPath(new URL('../scripts/release-production.sh', import.meta.url));
const shell = await readFile(shellPath, 'utf8');
const workflow = await readFile(new URL('../.github/workflows/deploy-oa.yml', import.meta.url), 'utf8');

test('activation is opt-in on the existing protected manual main release, never PR checks', () => {
  assert.doesNotMatch(shell, /\r/u);
  assert.match(workflow, /enable_ai_workbench:[\s\S]*?default: false[\s\S]*?type: boolean/u);
  assert.match(workflow, /enable_meeting_bot:[\s\S]*?default: false[\s\S]*?type: boolean/u);
  assert.match(workflow, /name: production-oa/u);
  assert.match(workflow, /group: oa-production/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  deploy:')), /OA_PRODUCTION_ENABLE_AI_WORKBENCH:/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  deploy:')), /OA_PRODUCTION_ENABLE_MEETING_BOT:/u);
  assert.match(shell, /workbench_enabled="\$\{OA_PRODUCTION_ENABLE_AI_WORKBENCH:-false\}"/u);
  assert.equal((shell.match(/workbench_deploy_args=\(--var OA_AI_TASKS_ENABLED:true\)/gu) || []).length, 1);
  assert.equal((shell.match(/"\$\{workbench_deploy_args\[@\]\}"/gu) || []).length, 2);
  assert.match(shell, /meeting_bot_enabled="\$\{OA_PRODUCTION_ENABLE_MEETING_BOT:-false\}"/u);
  assert.equal((shell.match(/meeting_bot_deploy_args=\(--var OA_MEETING_BOT_ENABLED:true\)/gu) || []).length, 1);
  assert.equal((shell.match(/"\$\{meeting_bot_deploy_args\[@\]\}"/gu) || []).length, 2);
  const positions = ['oa-workbench-release.mjs" before', 'oa-workbench-release.mjs" probe', 'd1 time-travel info DB', '--file "${release_root}/workbench/', 'oa-workbench-release.mjs" after', 'run_wrangler deploy --strict --keep-vars'].map(value => shell.indexOf(value));
  assert.ok(positions.every(value => value >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(shell, /find dist drizzle workbench -type f/u);
  assert.doesNotMatch(shell, /--file[^\n]*WEBSITE_DB|secret put OA_AI_TASKS_ENABLED|d1 time-travel restore/u);
});
test('release shell parses and refuses an unauthorised activation before running any command', () => {
  const parsed = spawnSync('/bin/bash', ['-n', shellPath], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const blocked = spawnSync('/bin/bash', [shellPath, 'production'], { encoding: 'utf8', env: { PATH: '/nonexistent', OA_PRODUCTION_ENABLE_AI_WORKBENCH: 'true' } });
  assert.equal(blocked.status, 64); assert.doesNotMatch(blocked.stderr, /command not found/u);
  const meetingBotBlocked = spawnSync('/bin/bash', [shellPath, 'production'], { encoding: 'utf8', env: { PATH: '/nonexistent', OA_PRODUCTION_ENABLE_MEETING_BOT: 'true' } });
  assert.equal(meetingBotBlocked.status, 64); assert.doesNotMatch(meetingBotBlocked.stderr, /command not found/u);
});

