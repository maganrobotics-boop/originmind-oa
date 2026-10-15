#!/usr/bin/env python3
"""Apply reviewed, incremental model hooks to independently patched live releases."""
import argparse
import hashlib
from pathlib import Path


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise SystemExit('Expected exactly one reviewed source anchor: ' + before[:70])
    return source.replace(before, after, 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--oa-root', required=True)
    parser.add_argument('--chat-root', required=True)
    parser.add_argument('--oa-client-sha256', required=True)
    parser.add_argument('--chat-bridge-sha256', required=True)
    options = parser.parse_args()
    paths = [Path(options.oa_root) / 'lib/oa-chat-client.ts', Path(options.chat_root) / 'chat-cloudflare/src/oa-chat-bridge.mjs']
    originals = [path.read_bytes() for path in paths]
    for value, expected in zip(originals, [options.oa_client_sha256, options.chat_bridge_sha256]):
        if hashlib.sha256(value).hexdigest() != expected:
            raise SystemExit('Source changed; inspect the live release before retrying')
    client, bridge = [value.decode('utf-8') for value in originals]
    client = replace_once(client, 'bridgeReady?: boolean };', 'bridgeReady?: boolean; message?: unknown; finishReason?: string };')
    client = replace_once(client, 'async function bridge(payload: object, timeoutMs: number): Promise<BridgeResponse>', 'async function bridge(payload: object, timeoutMs: number, signal?: AbortSignal): Promise<BridgeResponse>')
    client = replace_once(client, "credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),", "credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),")
    if 'export async function serverAgentModelTurn' in client:
        raise SystemExit('Model hook is already installed')
    client += """
/** Private model turn; OA retains server authority and Chat retains credentials. */
export async function serverAgentModelTurn(payload: object, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const result = await bridge(payload, 50000, options.signal);
  options.signal?.throwIfAborted();
  if (result.mode !== 'server_agent_turn' || !result.message) throw new Error('SERVER_AGENT_MODEL_PROTOCOL');
  return result;
}
"""
    bridge = replace_once(bridge, "import { answerMode } from './answer-mode.mjs';", "import { answerMode } from './answer-mode.mjs';\nimport { completeServerAgentTurn, validServerAgentPayload } from './server-agent-bridge.mjs';")
    bridge = replace_once(bridge, 'export function validOaChatPayload(value) {', "export function validOaChatPayload(value) {\n  if (value?.operation === 'server_agent_turn') return validServerAgentPayload(value);")
    bridge = replace_once(bridge, 'const active = engine.modelProvider(context, config);', "const active = engine.modelProvider(context, config);\n    if (payload.operation === 'server_agent_turn') return json(await completeServerAgentTurn(context, engine, config, payload));")
    diagnostic = "    if (payload.operation === 'server_agent_turn') {\n      const allowed = ['SERVER_AGENT_INPUT', 'SERVER_AGENT_MODEL_UNAVAILABLE', 'SERVER_AGENT_MODEL_PROTOCOL', 'SERVER_AGENT_MODEL_TOOL', 'SERVER_AGENT_MODEL_INCOMPLETE', 'TASK_MODEL_CONFIG', 'TASK_MODEL_HTTP', 'TASK_MODEL_PROTOCOL', 'TASK_MODEL_TRANSPORT', 'TASK_TOOL_TIMEOUT', 'TASK_TOOL_CONTEXT_LIMIT', 'TASK_MODEL_RESPONSE_LIMIT'];\n      const diagnostic = { code: allowed.includes(error?.message) ? error.message : 'SERVER_AGENT_UNAVAILABLE',\n        ...(Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}) };\n      return json({ error: '助手模型暂不可用，请稍后重试', diagnostic }, 503);\n    }\n"
    bridge = replace_once(bridge, "    if (payload.operation !== 'task')", diagnostic + "    if (payload.operation !== 'task')")
    for path, original, source in zip(paths, originals, [client, bridge]):
        backup = path.with_name(path.name + '.pre-server-agent')
        if backup.exists():
            raise SystemExit('Backup already exists; review candidate before retrying')
        backup.write_bytes(original)
        path.write_bytes(source.encode('utf-8'))
        print(path.relative_to(path.parents[1]), hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
