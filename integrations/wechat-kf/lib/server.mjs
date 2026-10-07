import http from 'node:http';
import fs from 'node:fs';
import { extractEncrypted, parseCallbackXml, verifyAndDecrypt } from './crypto.mjs';

export const CALLBACK_PATH = '/integrations/wechat-kf/callback';
const MAX_CALLBACK_BYTES = 16384;

export function loadConfig(envPath = '/etc/originmind-wechat-kf/env') {
  const values = {};
  // systemd reads the root-only EnvironmentFile before dropping privileges.
  if (!Object.prototype.hasOwnProperty.call(process.env, 'WECHAT_KF_TOKEN') && fs.existsSync(envPath)) {
    const stat = fs.statSync(envPath);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Configuration file must be private (0600)');
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) throw new Error('Invalid configuration format');
      values[match[1]] = match[2];
    }
  }
  const value = (key) => String(process.env[key] ?? values[key] ?? '').trim();
  const config = {
    host: '127.0.0.1', port: 3014,
    corpId: value('WECHAT_KF_CORP_ID'),
    secret: value('WECHAT_KF_SECRET'),
    openKfId: value('WECHAT_KF_OPEN_KF_ID'),
    token: value('WECHAT_KF_TOKEN'),
    encodingAESKey: value('WECHAT_KF_ENCODING_AES_KEY'),
    statePath: '/var/lib/originmind-wechat-kf/state.sqlite',
  };
  for (const [name, item] of [['corpId', config.corpId], ['openKfId', config.openKfId], ['secret', config.secret]]) {
    if (item && (!/^[A-Za-z0-9_-]+$/.test(item) || item.length > 256)) throw new Error(`Invalid ${name} configuration`);
  }
  if (config.token && !/^[A-Za-z0-9]{3,32}$/.test(config.token)) throw new Error('Invalid callback token');
  if (config.encodingAESKey && !/^[A-Za-z0-9+/]{43}$/.test(config.encodingAESKey)) throw new Error('Invalid AES key');
  return config;
}

export function configurationState(config) {
  const callbackReady = Boolean(config.corpId && config.token && config.encodingAESKey);
  return { callbackReady, configured: Boolean(callbackReady && config.secret && config.openKfId) };
}

function writeResponse(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(text);
}

function callbackParameters(url) {
  const get = (name, pattern, max) => {
    if (url.searchParams.getAll(name).length !== 1) throw new Error('Invalid callback parameters');
    const value = url.searchParams.get(name);
    if (!value || value.length > max || !pattern.test(value)) throw new Error('Invalid callback parameters');
    return value;
  };
  return {
    signature: get('msg_signature', /^[a-fA-F0-9]{40}$/, 40),
    timestamp: get('timestamp', /^\d{1,16}$/, 16),
    nonce: get('nonce', /^[A-Za-z0-9_-]+$/, 128),
  };
}

async function readCallback(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_BYTES) {
    const error = new Error('Callback too large'); error.status = 413; throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_CALLBACK_BYTES) {
      const error = new Error('Callback too large'); error.status = 413; throw error;
    }
    chunks.push(chunk);
  }
  if (!bytes) throw new Error('Empty callback');
  return Buffer.concat(chunks, bytes).toString('utf8');
}

export function createCallbackServer({ config, processor, queueReady = false, workerRunning = () => false, onError = () => {} }) {
  const readiness = configurationState(config);
  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url || request.url.length > 8192) return writeResponse(response, 400, 'bad request');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health' && request.method === 'GET') {
        return writeResponse(response, 200, JSON.stringify({ ok: true, ...readiness, queueReady: Boolean(queueReady), workerRunning: Boolean(workerRunning()) }), 'application/json; charset=utf-8');
      }
      if (url.pathname !== CALLBACK_PATH) return writeResponse(response, 404, 'not found');
      if (!['GET', 'POST'].includes(request.method)) return writeResponse(response, 405, 'method not allowed');
      if (!readiness.callbackReady) return writeResponse(response, 503, 'not configured');
      const parameters = callbackParameters(url);
      const cryptoConfig = { token: config.token, encodingAESKey: config.encodingAESKey, corpId: config.corpId, ...parameters };
      if (request.method === 'GET') {
        const encrypted = url.searchParams.get('echostr');
        if (!encrypted || url.searchParams.getAll('echostr').length !== 1 || encrypted.length > 4096) return writeResponse(response, 400, 'bad request');
        const echo = verifyAndDecrypt({ ...cryptoConfig, encrypted });
        return writeResponse(response, 200, echo);
      }
      if (!readiness.configured || !processor || !queueReady) return writeResponse(response, 503, 'not configured');
      const outerXml = await readCallback(request);
      const plaintext = verifyAndDecrypt({ ...cryptoConfig, encrypted: extractEncrypted(outerXml) });
      const event = parseCallbackXml(plaintext);
      if (event.event === 'kf_msg_or_event' && event.openKfId === config.openKfId) {
        if (!event.token) throw new Error('Callback token missing');
        // notify resolves only after the callback is durably queued; model work is done separately.
        try { await processor.notify(event.token); } catch {
          const error = new Error('Callback persistence unavailable'); error.status = 503; throw error;
        }
      }
      return writeResponse(response, 200, 'success');
    } catch (error) {
      const status = [413, 503].includes(error.status) ? error.status : 400;
      try { onError(status === 413 ? 'callback_too_large' : status === 503 ? 'callback_persistence_failed' : 'callback_rejected'); } catch {}
      if (!response.headersSent) writeResponse(response, status, status === 413 ? 'too large' : status === 503 ? 'temporarily unavailable' : 'bad request');
      else response.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

export { MAX_CALLBACK_BYTES };
