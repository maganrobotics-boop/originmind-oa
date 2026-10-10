import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('interactive bot setup keeps new secrets private and refuses to replace existing configuration', () => {
  const script = `
import contextlib, importlib.util, io, os, pathlib, stat, tempfile
source=pathlib.Path('scripts/configure-wecom-bot.py')
spec=importlib.util.spec_from_file_location('bot_setup',source)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
 def path(value):
  value=pathlib.Path(value)
  return pathlib.Path(root)/str(value).lstrip('/') if str(value).startswith('/etc/') else value
 module.Path=path
 module.os.geteuid=lambda:0
 module.input=lambda prompt:'aib-test'
 module.getpass.getpass=lambda prompt:'test-secret-do-not-display'
 output=io.StringIO()
 with contextlib.redirect_stdout(output):module.main()
 bot=path('/etc/originmind-wecom-bot/env');bridge=path('/etc/originmind-wecom-bot/bridge.env')
 assert 'test-secret-do-not-display' not in output.getvalue()
 assert 'test-secret-do-not-display' in bot.read_text()
 assert 'test-secret-do-not-display' not in bridge.read_text()
 assert 'OA_PUBLIC_ORIGIN=https://oa.omindos.cn\\n' in bridge.read_text()
 assert stat.S_IMODE(bot.stat().st_mode)==0o600
 assert stat.S_IMODE(bridge.stat().st_mode)==0o600
 assert bot.read_text().split('WECOM_BOT_BRIDGE_SECRET=')[1].splitlines()[0]==bridge.read_text().split('WECOM_BOT_BRIDGE_SECRET=')[1].splitlines()[0]
 before=bot.read_bytes()
 try:module.main()
 except SystemExit:pass
 else:raise AssertionError('existing configuration overwritten')
 assert bot.read_bytes()==before
 assert not list(path('/etc/originmind-wecom-bot').glob('.wecom-bot-*'))
print('safe setup verified')
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /safe setup verified/u);
  assert.doesNotMatch(result.stdout, /test-secret-do-not-display/u);
});

test('partial bot setup failure removes only files it created', () => {
  const script = `
import importlib.util, pathlib, tempfile
spec=importlib.util.spec_from_file_location('bot_setup',pathlib.Path('scripts/configure-wecom-bot.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
 def path(value):
  value=pathlib.Path(value)
  return pathlib.Path(root)/str(value).lstrip('/') if str(value).startswith('/etc/') else value
 module.Path=path;module.os.geteuid=lambda:0
 module.input=lambda prompt:'aib-test';module.getpass.getpass=lambda prompt:'test-secret-do-not-display'
 original=module.os.link;calls=[]
 def link(source,destination):
  calls.append(destination)
  if len(calls)==2:raise OSError('injected filesystem failure')
  original(source,destination)
 module.os.link=link
 try:module.main()
 except SystemExit:pass
 else:raise AssertionError('injected failure did not fail')
 assert not path('/etc/originmind-wecom-bot/env').exists()
 assert not path('/etc/originmind-wecom-bot/bridge.env').exists()
 assert not path('/etc/systemd/system/originmind-oa.service.d/30-wecom-bot.conf').exists()
 assert not list(path('/etc/originmind-wecom-bot').glob('.wecom-bot-*'))
print('rollback verified')
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollback verified/u);
});
