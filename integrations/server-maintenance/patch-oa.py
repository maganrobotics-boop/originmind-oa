#!/usr/bin/env python3
"""Apply only the maintenance hook to a verified existing OA adapter."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time


def patch(root, expected_sha256):
    target = Path(root).resolve() / 'aliyun/ai-members/oa-research.mjs'
    source = target.read_bytes()
    if hashlib.sha256(source).hexdigest() != expected_sha256:
        raise ValueError('OA adapter changed; inspect the new baseline before patching')
    text = source.decode('utf-8')
    signature = 'export function createOaResearchConversation({port,fetchImpl}){'
    entry = '  return async(request,question,{history=[],signal,onEvent}={})=>{'
    if text.count(signature) != 1 or text.count(entry) != 1 or 'createServerMaintenanceConversation' in text:
        raise ValueError('Unexpected OA research adapter structure')
    updated = "import { createServerMaintenanceConversation } from '/opt/originmind-maintenance/conversation.mjs';\n" + text
    updated = updated.replace(signature, signature + '\n  const maintenance = createServerMaintenanceConversation({port});', 1)
    updated = updated.replace(entry, entry + '\n    const maintenanceAnswer = await maintenance(request, question, {signal});\n    if (maintenanceAnswer) {\n      if (onEvent) await onEvent({type:"delta",text:maintenanceAnswer.answer});\n      return maintenanceAnswer;\n    }', 1)
    info = target.stat()
    backup = target.with_name(target.name + '.pre-maintenance-' + time.strftime('%Y%m%dT%H%M%S'))
    if backup.exists():
        raise ValueError('Backup already exists')
    shutil.copy2(target, backup)
    os.chown(backup, info.st_uid, info.st_gid)
    descriptor, temporary = tempfile.mkstemp(prefix='.oa-maintenance-', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(updated.encode('utf-8'))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, info.st_mode & 0o777)
        os.chown(temporary, info.st_uid, info.st_gid)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'target':str(target),'backup':str(backup),'sha256':hashlib.sha256(updated.encode('utf-8')).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--expected-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(patch(args.root, args.expected_sha256)))
