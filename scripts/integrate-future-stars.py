#!/usr/bin/env python3
"""Apply a narrow increment to the current Aliyun release, never replace it with main."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import pwd
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("--oa-root", type=Path, required=True)
parser.add_argument("--chat-root", type=Path, required=True)
parser.add_argument("--feature-root", type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument("--oa-user", help="Service account that must be able to read the copied OA release")
parser.add_argument("--chat-user", help="Service account that must be able to read the copied Chat release")
args = parser.parse_args()
manifest = {}

def install(root, name):
    src = args.feature_root / name
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, target)
    manifest[str(target)] = hashlib.sha256(target.read_bytes()).hexdigest()

def change(root, name, replacements):
    target = root / name
    text = target.read_text()
    for before, after in replacements:
        if after in text:
            continue
        if text.count(before) != 1:
            raise RuntimeError("Integration anchor changed: " + name + " " + before[:70])
        text = text.replace(before, after, 1)
    target.write_text(text)
    manifest[str(target)] = hashlib.sha256(target.read_bytes()).hexdigest()

for name in ["lib/future-stars-client.ts", "app/api/admin/future-stars/route.ts",
             "components/future-stars/future-stars.tsx", "components/future-stars/future-stars.css",
             "chat-cloudflare/src/future-stars-bridge.mjs"]:
    install(args.oa_root, name)
for name in ["chat-cloudflare/src/future-stars-bridge.mjs", "chat-cloudflare/src/future-stars-service.mjs",
             "chat-cloudflare/src/learning-honors.mjs", "chat-cloudflare/migrations/0008_learning_honors.sql",
             "aliyun/learning/future-stars.mjs", "aliyun/future-stars-migrate.mjs",
             "chat-cloudflare/public/learning/honors-trophy.svg", "chat-cloudflare/public/learning/honors.html",
             "chat-cloudflare/public/learning/honors-wall.css", "chat-cloudflare/public/learning/honors-wall.mjs"]:
    install(args.chat_root, name)

nav = "components/oa-eight-entry-navigation.tsx"
change(args.oa_root, "lib/write-rate-limit.ts", [
    ('"admin_control"; limit:', '"admin_control" | "future_stars"; limit:'),
])
change(args.oa_root, nav, [
    ("import { BookOpen, Bot, ClipboardCheck, LayoutDashboard, Mail, Upload }", "import { BookOpen, Bot, ClipboardCheck, LayoutDashboard, Mail, Upload, Sparkles }"),
    ("export type OaPrimaryView = 'project' | 'dashboard' | 'library' | 'model';",
     "export type OaPrimaryView = 'project' | 'dashboard' | 'library' | 'model' | 'future-stars';"),
    ("  { key: 'model', label: '大模型', icon: Bot },",
     "  { key: 'model', label: '大模型', icon: Bot },\n  { key: 'future-stars', label: '未来之星', icon: Sparkles },"),
    ("export function OaPrimaryNavigation({ active, onNavigate }: { active: OaPrimaryView; onNavigate: (view: OaPrimaryView) => void }) {",
     "export function OaPrimaryNavigation({ active, onNavigate, isAdmin = false }: { active: OaPrimaryView; onNavigate: (view: OaPrimaryView) => void; isAdmin?: boolean }) {"),
    ('className="oa-primary-navigation" aria-label="OA 主导航">{OA_PRIMARY_ENTRIES.map',
     'className="oa-primary-navigation" data-future-stars={isAdmin} aria-label="OA 主导航">{OA_PRIMARY_ENTRIES.filter(entry => entry.key !== "future-stars" || isAdmin).map'),
])
change(args.oa_root, "app/page.tsx", [
    ('import { OaPrimaryNavigation, type OaPrimaryView }',
     'import { FutureStars } from "@/components/future-stars/future-stars";\nimport { OaPrimaryNavigation, type OaPrimaryView }'),
    ('type ViewKey = "library" |', 'type ViewKey = "future-stars" | "library" |'),
    ('  const navigate = (view: ViewKey) => { setActiveView(view);',
     '  useEffect(() => { if (session?.isAdmin && window.location.hash === "#future-stars") { setActiveView("future-stars"); setPrimaryView("future-stars"); } }, [session?.isAdmin]);\n  const navigate = (view: ViewKey) => { if (view === "future-stars" && !session?.isAdmin) return; window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (view === "future-stars" ? "#future-stars" : "")); setActiveView(view); if (view === "future-stars") setPrimaryView("future-stars");'),
    ('  const secondaryTitle = activeView === "library" ?',
     '  const secondaryTitle = activeView === "future-stars" ? "未来之星" : activeView === "library" ?'),
    ('        {activeView === "library" ?',
     '        {activeView === "future-stars" ? (session.isAdmin ? <FutureStars key={session.user?.email} /> : null) : activeView === "library" ?'),
    ('<OaPrimaryNavigation active={primaryView} onNavigate=',
     '<OaPrimaryNavigation active={primaryView} isAdmin={Boolean(session.isAdmin)} onNavigate='),
])
change(args.chat_root, "aliyun/learning/service-core.mjs", [
    ("import { DatabaseSync } from 'node:sqlite';",
     "import { DatabaseSync } from 'node:sqlite';\nimport { createLearningPeople } from './future-stars.mjs';"),
    ("for(const name of ['honors.html','honors.mjs','honors.css','honors-trophy.webp'])files.add(name);",
     "for(const name of ['honors.html','honors.mjs','honors.css','honors-trophy.webp','honors-trophy.svg','honors-wall.css','honors-wall.mjs'])files.add(name);"),
    ("const types={'.webp':'image/webp','.html':", "const types={'.webp':'image/webp','.svg':'image/svg+xml','.html':"),
    ("        return await worker.fetch(request,env,{waitUntil(){}});",
     "        return new Response(null,{status:302,headers:{Location:'https://oa.omindos.cn/#future-stars','Cache-Control':'no-store'}});"),
    ("      if (url.pathname==='/learning/admin'||url.pathname==='/learning/admin/') {",
     "      if (['/learning/admin','/learning/admin/','/learning/honors/admin','/learning/honors/admin/'].includes(url.pathname)) {"),
    ("  return {handle,close:()=>db.close()};",
     "  return {handle,people:createLearningPeople({db,courses,progressFor,graduationSummary}),close:()=>db.close()};"),
])
# The superseded read-only registry branch is removed, so no second data source can serve honors.
core_path = args.chat_root / "aliyun/learning/service-core.mjs"
core = core_path.read_text()
delegate = "      if(['honors','my-honors'].includes(route))return worker.fetch(request,env,{waitUntil(){}});"
if delegate not in core:
    core, count = re.subn(r"      if\(\['honors','my-honors'\]\.includes\(route\)\)\{[\s\S]*?\n      \}\n", delegate + "\n", core, count=1)
    if count != 1:
        raise RuntimeError("Legacy honor data source changed")
core_path.write_text(core)
change(args.chat_root, "chat-cloudflare/public/learning/honors.mjs", [
    ("'祝贺'+award.name+'完成新手村项目！'", "'祝贺'+award.name+'获得'+award.title+'！'"),
    ("'🏆 '+mine[0].name+'，恭喜完成新手村项目！你的通关奖杯已颁发。'",
     "'🏆 '+mine[0].name+'，你的荣誉奖杯已颁发。'"),
    ("award.name+'的新手村通关奖杯'", "award.name+'的荣誉奖杯'"),
    ("download.download='新手村通关奖杯.webp'", "download.download='OriginMind荣誉奖杯.svg'"),
    ("profile.prepend(card);", "if(award.visibility==='hidden'){card.append(el('small','仅本人可见'));card.querySelector('a[href^=\"/learning/honors#\"]')?.remove();}profile.prepend(card);"),
])
change(args.chat_root, "aliyun/learning/service.mjs", [
    (" return {close:()=>core.close(),async handle(request){",
     " return {close:()=>core.close(),people:core.people,async handle(request){"),
])
change(args.chat_root, "aliyun/chat-server.mjs", [
    ("catch { console.error('Learning unavailable; existing Chat routes remain active'); }",
     "catch { console.error('Learning unavailable; existing Chat routes remain active'); }\nenv.FUTURE_STARS_LEARNING = learning?.people;"),
])
change(args.chat_root, "chat-cloudflare/src/app.mjs", [
    ("import { handleOaAdminBridge } from './oa-admin-bridge.mjs';",
     "import { handleOaAdminBridge } from './oa-admin-bridge.mjs';\nimport { handleFutureStarsBridge } from './future-stars-bridge.mjs';\nimport { handleFutureStarsOperation } from './future-stars-service.mjs';\nimport { handleHonorsRequest } from './learning-honors.mjs';"),
    ('    if (path === "internal/oa-admin") return handleOaAdminBridge',
     '    if (path === "internal/oa-future-stars") return handleFutureStarsBridge(context, {\n'
     '      claimRequest: async (nonce) => {\n'
     '        await consumeCounter(context, "oa-stars:" + nonce, 1, Math.floor(Date.now() / 1000) + 120);\n'
     '        await database(context).prepare("DELETE FROM limits WHERE expires < ?").bind(Math.floor(Date.now() / 1000)).run();\n'
     '      },\n'
     '      handle: payload => handleFutureStarsOperation(context, payload, { json, readJson, currentVisitor, requireOwner, sameOrigin, limit }),\n'
     '    });\n'
     '    if (/^learning\\/(honors(?:\\/[a-z0-9-]+)?|my-honors)$/u.test(path) || path === "admin/honors" || path.startsWith("admin/honors/")) {\n'
     '      return handleHonorsRequest(context, { json, readJson, currentVisitor, requireOwner, sameOrigin, limit });\n'
     '    }\n'
     '    if (path === "internal/oa-admin") return handleOaAdminBridge'),
])
for root, account_name in [(args.oa_root, args.oa_user), (args.chat_root, args.chat_user)]:
    if not account_name:
        continue
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("Ownership changes require a copied release directory")
    account = pwd.getpwnam(account_name)
    # copytree retains restrictive modes but assigns the copying user's ownership.
    # Do not traverse external runtime or data symlinks when restoring service access.
    for directory, dirs, files in os.walk(root, followlinks=False):
        os.chown(directory, account.pw_uid, account.pw_gid)
        for name in dirs + files:
            os.chown(Path(directory) / name, account.pw_uid, account.pw_gid, follow_symlinks=False)

manifest = {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in manifest}
print(json.dumps({"changedFiles": len(manifest), "files": manifest}, indent=2))
