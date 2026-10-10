import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/configure-wecom-login.py', import.meta.url));

test('WeCom configuration keeps the new login disabled and rejects environment injection', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util,sys
spec=importlib.util.spec_from_file_location('configuration',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
secret='Synthetic-Secret-123456789'
text=module.configuration('wwtestcorp','1000002',secret)
assert 'OA_UNIFIED_QR_LOGIN_ENABLED=false\\n' in text
assert 'WECOM_LOGIN_APP_SECRET='+secret+'\\n' in text
assert len(text.splitlines())==6
for values in [('bad\\ncorp','1000002',secret),('wwtestcorp','0',secret),('wwtestcorp','1000002','bad\\nINJECTED=true'),('wwtestcorp','1000002','$(command)abcdefgh')]:
 try: module.configuration(*values)
 except ValueError: pass
 else: raise AssertionError('unsafe configuration accepted')
print('configuration checks passed')
`, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'configuration checks passed');
});

test('noninteractive invocation refuses to read credentials or write a file', () => {
  const result = spawnSync('python3', [script], { encoding: 'utf8', input: 'SYNTHETIC_SECRET\n' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /交互终端/u);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_SECRET/u);
});
