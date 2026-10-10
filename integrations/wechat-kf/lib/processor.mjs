function coded(code, retryable = true) { const error = new Error(code); error.code = code; error.retryable = retryable; return error; }

// Split by Unicode code point, never in the middle of UTF-8; long answers get an
// explicit truncation suffix and fit within the remaining reply allowance.
export function splitText(text, { maxBytes = 2048, maxParts = 4 } = {}) {
  if (typeof text !== 'string' || !text.trim() || !Number.isInteger(maxParts) || maxParts < 1 || maxParts > 4) throw coded('ANSWER_INVALID', false);
  const chars = Array.from(text.trim());
  const parts = [];
  let current = '';
  let bytes = 0;
  let used = 0;
  for (const char of chars) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) {
      parts.push(current);
      current = ''; bytes = 0;
      if (parts.length === maxParts) break;
    }
    current += char; bytes += size; used++;
  }
  if (parts.length < maxParts && current) parts.push(current);
  if (used < chars.length) {
    const suffix = '\n（回复较长，后续可继续提问。）';
    const last = Array.from(parts.at(-1));
    while (Buffer.byteLength(last.join('') + suffix) > maxBytes) last.pop();
    parts[parts.length - 1] = last.join('') + suffix;
  }
  return parts;
}

export function createProcessor({ store, kfApi, answer, openKfId, concurrency = 2, maxQueue = 1000, now = Date.now, onError = () => {} }) {
  if (!store || !kfApi || typeof answer !== 'function' || store.openKfId !== openKfId
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || maxQueue !== store.maxQueue) throw coded('PROCESSOR_CONFIG', false);
  let running = null;
  let closed = false;
  let lastReconcile = now();
  let lastSyncFailure = 0;

  function report(error) {
    // Only a bounded machine code reaches telemetry; identities, prompts,
    // callback tokens, API errmsg, and credentials never leave this layer.
    const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(error.code) ? error.code : 'PROCESS_FAILED';
    try { onError({ code }); } catch { /* Telemetry must not interrupt delivery. */ }
    return code;
  }

  async function process(message) {
    if (!store.claim(message.id)) return;
    try {
      if (now() >= (message.sendTime + 48 * 3600) * 1000) { store.skip(message.id, 'WINDOW_EXPIRED'); return; }
      const state = await kfApi.getServiceState({ openKfId, userId: message.userId });
      if (![0, 1].includes(state)) { store.skip(message.id, 'HUMAN_OR_CLOSED'); return; }
      let slots = store.quota(message.userId, now());
      if (slots < 1) { store.skip(message.id, 'REPLY_LIMIT'); return; }
      if (message.answer === null) {
        const finalText = await answer({ userId: message.userId, text: message.text, history: store.getHistory(message.userId) });
        const chunks = splitText(finalText, { maxParts: Math.min(4, slots) });
        store.prepareAnswer(message.id, chunks.join(''), chunks);
      }
      for (const outgoing of store.outbox(message.id)) {
        if (closed) throw coded('PROCESSOR_CLOSED');
        if (outgoing.status === 'failed') throw coded('KF_DELIVERY_FAILED', false);
        if (outgoing.status !== 'pending') continue;
        if (now() >= (message.sendTime + 48 * 3600) * 1000 || store.quota(message.userId, now()) < 1) { store.skip(message.id, 'REPLY_LIMIT_OR_WINDOW'); return; }
        // Recheck on every part: a human may take over while the model generates.
        const currentState = await kfApi.getServiceState({ openKfId, userId: message.userId });
        if (![0, 1].includes(currentState)) { store.skip(message.id, 'HUMAN_OR_CLOSED'); return; }
        await kfApi.sendText({ openKfId, userId: message.userId, messageId: outgoing.messageId, text: outgoing.text });
        store.markSent(outgoing.messageId, now());
      }
      store.done(message.id);
    } catch (error) { store.retry(message.id, report(error), now(), error?.retryable !== false); }
  }

  async function processPending() {
    if (closed) return;
    const batch = store.listPending(concurrency, now());
    // One batch per drain keeps new callbacks and their short-lived sync tokens
    // from waiting behind the entire model queue.
    await Promise.all(batch.map(process));
  }

  async function sync() {
    const signal = store.latestSignal();
    const reconciliationDue = now() - lastReconcile >= 60000;
    if (!signal && !reconciliationDue) return;
    if (lastSyncFailure && now() - lastSyncFailure < 10000) return;
    let cursor = store.cursor();
    const token = signal && now() - signal.createdAt < 9 * 60 * 1000 ? signal.token : undefined;
    let complete = false;
    try {
      // Bound one drain invocation. Further pages remain durable via the signal.
      for (let page = 0; page < 10 && !closed; page++) {
        const capacity = store.capacity();
        if (capacity < 1) return;
        const result = await kfApi.syncMessages({ cursor, token, openKfId, limit: Math.min(100, capacity) });
        store.ingestBatch({ cursor: result.nextCursor, messages: result.messages, now: now() });
        const previousCursor = cursor;
        cursor = result.nextCursor;
        if (!result.hasMore) { complete = true; break; }
        // An empty list with has_more=1 must continue. A stuck cursor must wait
        // for recovery instead of spinning or losing the callback notification.
        if (cursor === previousCursor) throw coded('SYNC_CURSOR_STALLED');
      }
      if (complete) {
        if (signal) store.clearSignal(signal.token);
        lastReconcile = now();
        lastSyncFailure = 0;
      }
    } catch (error) { lastSyncFailure = now(); report(error); }
  }

  return Object.freeze({
    async notify(syncToken) {
      if (closed) throw coded('PROCESSOR_CLOSED');
      store.saveSignal(syncToken, now());
    },
    drain() {
      if (closed) return Promise.resolve();
      if (!running) running = (async () => { await sync(); await processPending(); })().finally(() => { running = null; });
      return running;
    },
    async close() { closed = true; if (running) await running; },
  });
}
