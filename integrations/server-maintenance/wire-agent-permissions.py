#!/usr/bin/env python3
"""Incrementally wire private web search into independently maintained releases."""
import argparse
import hashlib
from pathlib import Path


def once(source, before, after):
    if source.count(before) != 1:
        raise SystemExit('Unexpected source anchor: ' + before[:80])
    return source.replace(before, after, 1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--oa-root', required=True)
    p.add_argument('--chat-root', required=True)
    p.add_argument('--client-sha256', required=True)
    p.add_argument('--bridge-sha256', required=True)
    args = p.parse_args()
    paths = [Path(args.oa_root)/'lib/oa-chat-client.ts', Path(args.chat_root)/'chat-cloudflare/src/oa-chat-bridge.mjs']
    raw = [path.read_bytes() for path in paths]
    for data, expected in zip(raw, [args.client_sha256, args.bridge_sha256]):
        if hashlib.sha256(data).hexdigest() != expected:
            raise SystemExit('Release source changed; inspect before applying')
    client, bridge = [data.decode() for data in raw]
    client = once(client, 'finishReason?: string };', 'finishReason?: string; searched?: boolean; sources?: Array<{index: number; title: string; url: string}> };')
    if 'export async function serverAgentWebSearch' in client:
        raise SystemExit('Already wired')
    client += """
export async function serverAgentWebSearch(query: string, options: { signal?: AbortSignal } = {}) {
  const result = await bridge({ operation: 'server_agent_web_search', query }, 50000, options.signal);
  if (result.mode !== 'server_agent_web_search' || result.searched !== true || !result.sources?.length) throw new Error('SERVER_AGENT_SEARCH_UNAVAILABLE');
  return result;
}
"""
    anchor = "import { completeServerAgentTurn, validServerAgentPayload } from './server-agent-bridge.mjs';"
    bridge = once(bridge, anchor, anchor + "\nimport { completeServerAgentWebSearch, validServerAgentWebSearchPayload } from './server-agent-web-search.mjs';")
    bridge = once(bridge, 'export function validOaChatPayload(value) {', "export function validOaChatPayload(value) {\n  if (value?.operation === 'server_agent_web_search') return validServerAgentWebSearchPayload(value);")
    bridge = once(bridge, 'const active = engine.modelProvider(context, config);', "const active = engine.modelProvider(context, config);\n    if (payload.operation === 'server_agent_web_search') return json(await completeServerAgentWebSearch(context, engine, config, payload));")
    bridge = once(bridge, "if (payload.operation === 'server_agent_turn') {", "if (payload.operation === 'server_agent_turn' || payload.operation === 'server_agent_web_search') {")
    codes = ['SERVER_AGENT_SEARCH_CONFIG','SERVER_AGENT_SEARCH_UNAVAILABLE','SERVER_AGENT_SEARCH_INPUT','SERVER_AGENT_SEARCH_HTTP','SERVER_AGENT_SEARCH_PROTOCOL','SERVER_AGENT_SEARCH_NO_SOURCES','SERVER_AGENT_SEARCH_RESPONSE_LIMIT','SERVER_AGENT_SEARCH_TIMEOUT','SERVER_AGENT_SEARCH_TRANSPORT']
    bridge = once(bridge, "'TASK_MODEL_RESPONSE_LIMIT'];", "'TASK_MODEL_RESPONSE_LIMIT', " + ', '.join(repr(code) for code in codes) + '];')
    for path, original, source in zip(paths, raw, [client, bridge]):
        backup = path.with_name(path.name + '.pre-permissions-v4')
        if backup.exists():
            raise SystemExit('Backup already exists')
        backup.write_bytes(original)
        path.write_bytes(source.encode())
        print(str(path), hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
