import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/wecom-bot.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, args, { env: {}, encoding: 'utf8', timeout: 5000 });
const assertStartupFailure = (result) => {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    service: 'originmind-wecom-bot', status: 'startup_failed',
  });
};

test('direct CLI entrypoint reports invalid configuration with a failing exit code', () => {
  assertStartupFailure(run([script]));
});

test('CLI starts through a current release symlink instead of silently exiting', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'wecom-bot-entrypoint-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const current = join(temporaryRoot, 'current');
  await symlink(projectRoot, current, 'dir');
  assertStartupFailure(run([join(current, 'scripts', 'wecom-bot.mjs')]));
});

test('importing the entrypoint preserves explicit startup without starting the daemon', () => {
  const scriptUrl = new URL('../scripts/wecom-bot.mjs', import.meta.url).href;
  const result = run(['--input-type=module', '--eval',
    `const { startBot } = await import(${JSON.stringify(scriptUrl)}); console.log(typeof startBot);`]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'function\n');
});
