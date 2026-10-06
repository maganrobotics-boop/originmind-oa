"""Integration checks use source snippets matching the archived deployment boundaries."""
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('integration', ROOT / 'scripts/integrate-future-stars-activity.py')
integration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integration)


class IncrementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.oa, self.chat = [Path(self.temp.name) / name for name in ['oa-candidate', 'chat-candidate']]
        self.write(self.oa, 'app/api/admin/future-stars/route.ts', "const operation = ({ students: 'people' });")
        self.write(self.chat, 'aliyun/learning/service-core.mjs', "  const parentCourses=JSON.parse(readFileSync(path.join(assets,'advanced-courses.json'),'utf8')).flatMap(item=>item.courses||[item]);\nreturn {people:createLearningPeople({db,courses,progressFor,graduationSummary})};")
        self.write(self.chat, 'chat-cloudflare/src/app.mjs', '  return row ? { email: row.email, role: row.role, roleLabel: roleLabel(row.role) } : null;')
        self.write(self.chat, 'aliyun/chat-server.mjs', "catch { console.error('Arena authentication unavailable; competition actions remain locked'); }")

    def write(self, root, name, text):
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def apply(self, changes):
        for target, text in changes.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)

    def test_disconnected_is_explicit_and_planning_does_not_write(self):
        before = (self.oa / 'app/api/admin/future-stars/route.ts').read_text()
        changes, connected = integration.plan(self.oa, self.chat, ROOT)
        self.assertFalse(connected)
        self.assertEqual((self.oa / 'app/api/admin/future-stars/route.ts').read_text(), before)
        self.assertIn(self.chat / 'aliyun/arena-admin.mjs', changes)
        self.apply(changes)
        again, connected = integration.plan(self.oa, self.chat, ROOT)
        self.assertTrue(all(target.read_text() == text for target, text in again.items()))

    def test_existing_deployed_arena_is_read_only_and_idempotent(self):
        self.write(self.chat, 'aliyun/arena-proxy.mjs', """import { createAccountHome } from './arena-account-home.mjs';
export function createProxy(){
async function signedRequest(owner,route,value,mapId) {
 return transport({path:'/arena'+route,method:'POST',headers,body});
}
async function privateActivity(owner,value){ return signedRequest(owner,'/api/my-activity',value); }
const owner = createHmac('sha256',authKey).update('campus:'+email).digest('hex');
async function session(){
    return { signedIn: Boolean(user), user, emailLoginConfigured: data.emailLoginConfigured === true };
}
  return {
    async handle(request) {}
  };
}
""")
        changes, connected = integration.plan(self.oa, self.chat, ROOT)
        self.assertTrue(connected)
        self.apply(changes)
        again, connected = integration.plan(self.oa, self.chat, ROOT)
        self.assertTrue(connected)
        self.assertTrue(all(target.read_text() == text for target, text in again.items()))
        proxy = (self.chat / 'aliyun/arena-proxy.mjs').read_text()
        subprocess.run(['node', '--check', str(self.chat / 'aliyun/arena-proxy.mjs')], check=True, capture_output=True)
        self.assertEqual(proxy.count('overview:createArenaAdmin'), 1)
        self.assertIn("activity:privateActivity", proxy)
        self.assertIn('value,undefined,signal', proxy)

    def test_changed_anchor_aborts_without_partial_writes(self):
        self.write(self.chat, 'aliyun/learning/service-core.mjs', 'changed implementation')
        before = {p: p.read_bytes() for root in [self.oa, self.chat] for p in root.rglob('*') if p.is_file()}
        with self.assertRaises(ValueError):
            integration.plan(self.oa, self.chat, ROOT)
        after = {p: p.read_bytes() for root in [self.oa, self.chat] for p in root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()
