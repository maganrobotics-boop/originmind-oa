#!/usr/bin/env python3
"""Wire maintenance into a verified, independently patched live OA source."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def wire(root, source, expected):
    root, source = Path(root).resolve(), Path(source).resolve()
    paths = ['app/api/lab-ai/ask/route.ts', 'components/knowledge/oa-chat-panel.tsx', 'lib/oa-chat-indicators.mjs']
    originals = {}
    for name, digest in zip(paths, expected):
        raw = (root / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Unexpected production baseline: ' + name)
        originals[name] = raw.decode('utf-8')
    route = originals[paths[0]]
    if 'answerServerMaintenanceQuestion' in route:
        raise ValueError('Main chat already wired')
    auth = 'import { getAuthorizedUser } from "../../_lib/auth";'
    if route.count(auth) != 1:
        raise ValueError('Unexpected auth import')
    route = route.replace(auth, 'import { answerServerMaintenanceQuestion } from "../../../../lib/server-maintenance-ask.mjs";\n' + auth, 1)
    lines = route.splitlines(keepends=True)
    matches = [n for n, line in enumerate(lines) if 'if (!(await consumeWriteRateLimit(' in line]
    if len(matches) != 1:
        raise ValueError('Unexpected rate-limit gate')
    lines.insert(matches[0] + 1, '    const maintenance = await answerServerMaintenanceQuestion(request, question);\n    if (maintenance) return finish(privateJson({ ...maintenance, citations: [], images: [] }));\n')
    panel = originals[paths[1]]
    old = "['ai', 'general', 'personnel'].includes(data.mode || '')"
    new = "(['ai', 'general', 'personnel'].includes(data.mode || '') || (data.mode === 'server_maintenance' && data.operationConfirmed === true))"
    if panel.count(old) != 1 or panel.count('type Reply = {') != 1:
        raise ValueError('Unexpected production reply handling')
    panel = panel.replace(old, new, 1).replace('type Reply = {', 'type Reply = { operationConfirmed?: boolean;', 1)
    indicator = originals[paths[2]]
    desired = (source / 'lib/oa-chat-indicators.mjs').read_text()
    start = desired.index("  if (value.mode === 'server_maintenance') {")
    end = desired.index("  if (value.mode === 'ai'", start)
    block = desired[start:end]
    anchor = "  const received = [ready('已收到本次提问响应'), ready('本次提问通过 OA 身份校验')];"
    if indicator.count(anchor) != 1 or "value.mode === 'server_maintenance'" in indicator:
        raise ValueError('Unexpected production indicators')
    indicator = indicator.replace(anchor, anchor + '\n' + block.rstrip('\n'), 1)
    results = {paths[0]: ''.join(lines), paths[1]: panel, paths[2]: indicator}
    for name, content in results.items():
        (root / name).write_bytes(content.encode('utf-8'))
    for name in ['lib/server-maintenance-ask.mjs', 'lib/server-maintenance-ask.d.mts']:
        shutil.copyfile(source / name, root / name)
        (root / name).chmod(0o644)
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--route-sha256', required=True)
    parser.add_argument('--panel-sha256', required=True)
    parser.add_argument('--indicators-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(wire(args.root, args.source, [args.route_sha256, args.panel_sha256, args.indicators_sha256])))
