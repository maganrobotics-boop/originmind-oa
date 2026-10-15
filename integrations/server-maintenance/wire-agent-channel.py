#!/usr/bin/env python3
"""Add the server assistant beside the external model entry in verified OA source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


PRODUCTION_PAGE_SHA256 = '46d809cc20dc9fba063ab29d007ca313fbad20c0a3ccc866dfdc4ae81c6d2b62'
IMPORT = 'import { ServerAssistantEntry } from "@/components/server-assistant-entry";'
IMPORT_ANCHOR = 'import { OaAiMemberDirectory, OaAiMemberProvider, OaAiChatEntrances, OaResearchWorkspace } from "@/components/ai-member-directory";'
EXTERNAL_ENTRY = '<a href="https://chat.omindos.cn/" target="_blank" rel="noreferrer">实验室对外大模型 ↗</a>'
ENTRY = '<ServerAssistantEntry isAdmin={Boolean(session.isAdmin)} />'
ROW_END = '</div><OaAiChatEntrances />'


def wire(root, expected=PRODUCTION_PAGE_SHA256):
    path = Path(root).resolve() / 'app/page.tsx'
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('Production page must be a regular file')
    original = path.read_bytes()
    if hashlib.sha256(original).hexdigest() != expected:
        raise ValueError('Unexpected production baseline: app/page.tsx')
    page = original.decode('utf-8')
    if 'ServerAssistantEntry' in page:
        raise ValueError('Server assistant entry already wired')
    if page.count(IMPORT_ANCHOR) != 1 or page.count(EXTERNAL_ENTRY + ROW_END) != 1:
        raise ValueError('Unexpected production model-entry placement')
    if page.count('<div className="oa-model-entrances">') != 1:
        raise ValueError('Unexpected production model-entry row')
    newline = '\r\n' if b'\r\n' in original else '\n'
    result = page.replace(IMPORT_ANCHOR, IMPORT + newline + IMPORT_ANCHOR, 1)
    result = result.replace(EXTERNAL_ENTRY + ROW_END, EXTERNAL_ENTRY + ENTRY + ROW_END, 1).encode('utf-8')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.server-assistant-entry-', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(result)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(stat.S_IMODE(metadata.st_mode))
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        if path.read_bytes() != original:
            raise ValueError('Production page changed during patch')
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {'path': 'app/page.tsx', 'before': expected, 'after': hashlib.sha256(result).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--page-sha256', default=PRODUCTION_PAGE_SHA256)
    arguments = parser.parse_args()
    print(json.dumps(wire(arguments.root, arguments.page_sha256)))
