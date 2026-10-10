#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { attachBotClient, createBotMessageHandler, createBridgeClient, createSafeLogger, readBotEnvironment } from '../lib/wecom-bot-transport.mjs';

const requireBotSdk = createRequire(new URL('../deploy/wecom-bot/package.json', import.meta.url));

export async function startBot({ env = process.env, loadSdk = () => requireBotSdk('@wecom/aibot-node-sdk'), logger = createSafeLogger(), onStop = () => { process.exitCode = 0; }, onFatalStop = () => { process.exitCode = 1; } } = {}) {
  const config = readBotEnvironment(env);
  const sdkModule = await loadSdk();
  const WSClient = sdkModule.WSClient || sdkModule.default?.WSClient;
  if (typeof WSClient !== 'function') throw new Error('invalid_sdk');
  const client = new WSClient({
    botId: config.botId,
    secret: config.botSecret,
    maxReconnectAttempts: 10,
    maxAuthFailureAttempts: 3,
    wsOptions: { maxPayload: 64 * 1024 },
    logger: logger.sdk,
  });
  const bridge = createBridgeClient({ endpoint: config.bridgeUrl, secret: config.bridgeSecret });
  const handler = createBotMessageHandler({ botId: config.botId, bridge, logger,
    sendReply: (frame, streamId, text, finish) => client.replyStream(frame, streamId, text, finish),
  });
  const runtime = attachBotClient(client, handler, { botId: config.botId, logger, onIntentionalStop: onStop, onFatalStop });
  logger.status('startup_ready');
  client.connect();
  return runtime;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // systemd executes through the current release symlink; Node resolves the
    // module URL to its real path, while argv retains the symlink path.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const logger = createSafeLogger();
  try {
    const runtime = await startBot({ logger });
    process.once('SIGTERM', () => runtime.stop());
    process.once('SIGINT', () => runtime.stop());
  } catch {
    logger.status('startup_failed');
    process.exitCode = 1;
  }
}
