#!/usr/bin/env node
import fs from 'node:fs';
import { createCallbackServer, configurationState, loadConfig } from '../lib/server.mjs';
import { createChatAnswer } from '../lib/chat.mjs';
import { createStore } from '../lib/store.mjs';
import { createKfApi } from '../lib/kf-api.mjs';
import { createProcessor } from '../lib/processor.mjs';

function log(event) { process.stdout.write(`${JSON.stringify({ event })}\n`); }

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'check-config'].includes(command) || process.argv.length > 3) throw new Error('Invalid command');
  const config = loadConfig();
  const status = configurationState(config);
  if (command === 'check-config') {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  let store;
  let processor;
  let shuttingDown = false;
  let workerRunning = false;
  if (status.configured) {
    fs.mkdirSync('/var/lib/originmind-wechat-kf', { recursive: true, mode: 0o700 });
    store = createStore(config.statePath, { openKfId: config.openKfId, enabledAt: Date.now() });
    processor = createProcessor({
      store,
      kfApi: createKfApi({ corpId: config.corpId, secret: config.secret }),
      answer: createChatAnswer({ onError: log }),
      openKfId: config.openKfId,
      onError: () => log('worker_failed'),
    });
  }
  const server = createCallbackServer({ config, processor, queueReady: Boolean(store), workerRunning: () => workerRunning, onError: log });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  log(status.configured ? 'service_started' : 'service_waiting_for_configuration');
  const runWorker = async () => {
    if (!processor || workerRunning || shuttingDown) return;
    workerRunning = true;
    try { await processor.drain(); } catch { log('worker_failed'); } finally { workerRunning = false; }
  };
  const timer = setInterval(runWorker, 2000);
  timer.unref();
  void runWorker();
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(0), 12000);
    deadline.unref();
    await new Promise((resolve) => server.close(resolve));
    try { await processor?.close(); } catch { log('worker_shutdown_failed'); }
    try { store?.close(); } catch { log('store_shutdown_failed'); }
    clearTimeout(deadline);
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

main().catch(() => {
  process.stderr.write('Wechat customer-service bridge could not start. Check private configuration and runtime.\n');
  process.exitCode = 1;
});
