import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const shellPath = fileURLToPath(new URL('../scripts/release-production.sh', import.meta.url));
const shell = await readFile(shellPath, 'utf8');
const workflow = await readFile(new URL('../.github/workflows/deploy-oa.yml', import.meta.url), 'utf8');

test('retired OA workflow cannot activate workbench, meeting bot, or webmail', () => {
  assert.match(workflow, /name: Check retired OA code/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request_target|^\s{2}deploy:|production-oa|oa-production/gmu);
  assert.doesNotMatch(workflow, /enable_ai_workbench|enable_meeting_bot|enable_feishu_webmail|OA_PRODUCTION_ENABLE_|secrets\.|CLOUDFLARE_API_TOKEN|PUBLIC_LAB_AI_SERVICE_TOKEN/u);
  assert.doesNotMatch(workflow, /release:standalone|release-production\.sh|release-standalone\.sh|wrangler\s+(?:deploy|publish)/u);
  for (const command of ['npm run install:ci', 'npm run typecheck', 'npm run lint', 'npm test']) {
    assert.ok(workflow.includes(`run: ${command}`), `retired CI must retain ${command}`);
  }
});

test('retained historical release shell still gates feature activation and migration order', () => {
  assert.doesNotMatch(shell, /\r/u);
  assert.match(shell, /workbench_enabled="\$\{OA_PRODUCTION_ENABLE_AI_WORKBENCH:-false\}"/u);
  assert.equal((shell.match(/workbench_deploy_args=\(--var OA_AI_TASKS_ENABLED:true\)/gu) || []).length, 1);
  assert.equal((shell.match(/"\$\{workbench_deploy_args\[@\]\}"/gu) || []).length, 2);
  assert.match(shell, /meeting_bot_enabled="\$\{OA_PRODUCTION_ENABLE_MEETING_BOT:-false\}"/u);
  assert.equal((shell.match(/meeting_bot_deploy_args=\(--var OA_MEETING_BOT_ENABLED:true\)/gu) || []).length, 1);
  assert.equal((shell.match(/"\$\{meeting_bot_deploy_args\[@\]\}"/gu) || []).length, 2);
  assert.match(shell, /feishu_webmail_enabled="\$\{OA_PRODUCTION_ENABLE_FEISHU_WEBMAIL:-false\}"/u);
  assert.equal((shell.match(/feishu_webmail_deploy_args=\(--var OA_WEBMAIL_URL:https:\/\/omindos\.feishu\.cn\/mail\)/gu) || []).length, 1);
  assert.equal((shell.match(/"\$\{feishu_webmail_deploy_args\[@\]\}"/gu) || []).length, 2);
  const positions = ['oa-workbench-release.mjs" before', 'oa-workbench-release.mjs" probe', 'd1 time-travel info DB', '--file "${release_root}/workbench/', 'oa-workbench-release.mjs" after', 'run_wrangler deploy --strict --keep-vars'].map(value => shell.indexOf(value));
  assert.ok(positions.every(value => value >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(shell, /find dist drizzle workbench -type f/u);
  assert.doesNotMatch(shell, /--file[^\n]*WEBSITE_DB|secret put OA_AI_TASKS_ENABLED|d1 time-travel restore/u);
});
test('release shell parses and refuses an unauthorised activation before running any command', { skip: process.platform === 'win32' ? 'requires a POSIX shell' : false }, () => {
  const parsed = spawnSync('/bin/bash', ['-n', shellPath], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const blocked = spawnSync('/bin/bash', [shellPath, 'production'], { encoding: 'utf8', env: { PATH: '/nonexistent', OA_PRODUCTION_ENABLE_AI_WORKBENCH: 'true' } });
  assert.equal(blocked.status, 64); assert.doesNotMatch(blocked.stderr, /command not found/u);
  const meetingBotBlocked = spawnSync('/bin/bash', [shellPath, 'production'], { encoding: 'utf8', env: { PATH: '/nonexistent', OA_PRODUCTION_ENABLE_MEETING_BOT: 'true' } });
  assert.equal(meetingBotBlocked.status, 64); assert.doesNotMatch(meetingBotBlocked.stderr, /command not found/u);
  const webmailBlocked = spawnSync('/bin/bash', [shellPath, 'production'], { encoding: 'utf8', env: { PATH: '/nonexistent', OA_PRODUCTION_ENABLE_FEISHU_WEBMAIL: 'true' } });
  assert.equal(webmailBlocked.status, 64); assert.doesNotMatch(webmailBlocked.stderr, /command not found/u);
});
