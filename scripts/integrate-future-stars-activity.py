#!/usr/bin/env python3
"""Preflight and apply only the activity increment to COPIES of existing releases.

Default is dry-run. This script never restarts services or switches release links.
All anchors are checked before any candidate file is written.
"""
import argparse
import hashlib
import json
from pathlib import Path


def plan(oa, chat, source):
    changes = {}

    def content(root, name):
        target = root / name
        if target.is_symlink():
            raise ValueError(f'Refusing symlink: {target}')
        return target, changes.get(target, target.read_text())

    def replace(root, name, before, after):
        target, text = content(root, name)
        if after in text:
            return
        if text.count(before) != 1:
            raise ValueError(f'Integration anchor changed: {name}: {before[:60]}')
        changes[target] = text.replace(before, after, 1)

    def install(root, name):
        target = root / name
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root.parent):
            raise ValueError(f'Refusing symlink: {target}')
        changes[target] = (source / name).read_text()

    for name in ['components/future-stars/future-stars.tsx', 'components/future-stars/future-stars.css',
                 'components/future-stars/arena-overview.tsx', 'chat-cloudflare/src/future-stars-bridge.mjs',
                 'chat-cloudflare/src/activity-windows.mjs']:
        install(oa, name)
    for name in ['aliyun/learning/future-stars.mjs', 'aliyun/arena-admin.mjs',
                 'chat-cloudflare/src/future-stars-bridge.mjs', 'chat-cloudflare/src/future-stars-service.mjs',
                 'chat-cloudflare/src/activity-windows.mjs']:
        install(chat, name)
    replace(oa, 'app/api/admin/future-stars/route.ts', "({ students: 'people'", "({ arena: 'arena', students: 'people'")
    replace(chat, 'aliyun/learning/service-core.mjs',
            "  const parentCourses=JSON.parse(readFileSync(path.join(assets,'advanced-courses.json'),'utf8')).flatMap(item=>item.courses||[item]);",
            "  const courseStages=JSON.parse(readFileSync(path.join(assets,'advanced-courses.json'),'utf8'));\n  const parentCourses=courseStages.flatMap(item=>item.courses||[item]);")
    replace(chat, 'aliyun/learning/service-core.mjs',
            'people:createLearningPeople({db,courses,progressFor,graduationSummary})',
            "people:createLearningPeople({db,courses,progressFor,graduationSummary,canonicalId:courseProgression.canonicalId,stages:[{id:'foundation',title:'新手村',courses:basicCourses},...courseStages]})")
    _, app = content(chat, 'chat-cloudflare/src/app.mjs')
    if 'FUTURE_STARS_LEARNING?.touch(row.email' not in app:
        anchor = '  return row ? { email: row.email, role: row.role, roleLabel: roleLabel(row.role) } : null;'
        replace(chat, 'chat-cloudflare/src/app.mjs', anchor,
                "  if (row) {\n    try { context.env.FUTURE_STARS_LEARNING?.touch(row.email, Date.now()); }\n    catch { console.error('LEARNING_PRESENCE_WRITE_FAILED'); }\n  }\n" + anchor)

    arena = chat / 'aliyun/arena-proxy.mjs'
    connected = False
    if arena.exists():
        _, proxy = content(chat, 'aliyun/arena-proxy.mjs')
        # These are the verified deployed boundaries; never synthesize a public admin endpoint.
        connected = all(anchor in proxy for anchor in ['createAccountHome', 'async function privateActivity(owner,value',
            "signedRequest(owner,'/api/my-activity',value", "createHmac('sha256',authKey).update('campus:'"])
        if connected:
            replace(chat, 'aliyun/arena-proxy.mjs', "import { createAccountHome } from './arena-account-home.mjs';",
                    "import { createAccountHome } from './arena-account-home.mjs';\nimport { createArenaAdmin } from './arena-admin.mjs';")
            overview = "    overview:createArenaAdmin({db:env.DB,ownerFor:email=>createHmac('sha256',authKey).update('campus:'+email).digest('hex'),activity:privateActivity,clock}),"
            replace(chat, 'aliyun/arena-proxy.mjs', '  return {\n    async handle(request) {', '  return {\n' + overview + '\n    async handle(request) {')
            # Transport cancellation is optional for the personal endpoint, always bounded for admin reads.
            replace(chat, 'aliyun/arena-proxy.mjs', 'async function privateActivity(owner,value)', 'async function privateActivity(owner,value,{signal}={})')
            replace(chat, 'aliyun/arena-proxy.mjs', "signedRequest(owner,'/api/my-activity',value)", "signedRequest(owner,'/api/my-activity',value,undefined,signal)")
            replace(chat, 'aliyun/arena-proxy.mjs', 'async function signedRequest(owner,route,value,mapId)', 'async function signedRequest(owner,route,value,mapId,signal)')
            _, proxy = content(chat, 'aliyun/arena-proxy.mjs')
            old = "method:'POST',headers,body,...(route==='/api/my-activity'?{signal:AbortSignal.timeout(12000)}:{})"
            if old in proxy:
                replace(chat, 'aliyun/arena-proxy.mjs', old, "method:'POST',headers,body,signal:signal || (route==='/api/my-activity'?AbortSignal.timeout(12000):undefined)")
            else:
                replace(chat, 'aliyun/arena-proxy.mjs', "method:'POST',headers,body});", "method:'POST',headers,body,signal:signal || (route==='/api/my-activity'?AbortSignal.timeout(12000):undefined)});")
            _, proxy = content(chat, 'aliyun/arena-proxy.mjs')
            if "home.presence(createHmac('sha256',authKey)" not in proxy:
                anchor = '    return { signedIn: Boolean(user), user, emailLoginConfigured: data.emailLoginConfigured === true };'
                replace(chat, 'aliyun/arena-proxy.mjs', anchor,
                        "    if (user) {\n      try { await home.presence(createHmac('sha256',authKey).update('campus:'+user.email).digest('hex'),{action:'visit'}); }\n      catch { console.error('ARENA_PRESENCE_WRITE_FAILED'); }\n    }\n" + anchor)
            replace(chat, 'aliyun/chat-server.mjs',
                    "catch { console.error('Arena authentication unavailable; competition actions remain locked'); }",
                    "catch { console.error('Arena authentication unavailable; competition actions remain locked'); }\nenv.FUTURE_STARS_ARENA = arenaProxy;")
        elif 'FUTURE_STARS_ARENA' in (chat / 'aliyun/chat-server.mjs').read_text():
            raise ValueError('Existing Arena binding has changed; inspect before adapting')
    return changes, connected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--oa-root', type=Path, required=True)
    parser.add_argument('--chat-root', type=Path, required=True)
    parser.add_argument('--feature-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--apply', action='store_true', help='Write to copied candidate directories after all preflight checks')
    args = parser.parse_args()
    for root in [args.oa_root, args.chat_root]:
        if root.is_symlink() or not root.is_dir() or root.name.endswith('-current'):
            raise ValueError('Use a copied candidate release, not a current release link')
    changes, connected = plan(args.oa_root, args.chat_root, args.feature_root)
    modified = {target: text for target, text in changes.items() if not target.exists() or target.read_text() != text}
    if args.apply:
        for target, text in modified.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
    print(json.dumps({'applied': args.apply, 'arenaWiring': 'connected' if connected else 'not_connected',
                      'files': {str(target): hashlib.sha256(text.encode()).hexdigest() for target, text in modified.items()}}, indent=2))


if __name__ == '__main__':
    main()
