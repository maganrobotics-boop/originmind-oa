const CHAT_URL = 'http://127.0.0.1:3001/api/chat';
const CHAT_ORIGIN = 'https://chat.omindos.cn';
const MAX_REQUEST_BYTES = 160000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_FINAL_BYTES = 32000;
const FAILURE_TEXT = '抱歉，助教暂时无法回答，请稍后重试，或打开 https://chat.omindos.cn 继续学习。';
const COURSE_PROMPT = '你是 ARTS Robotics 公开课程的 AI 助教。请用简洁、清楚的中文解答机器人课程和在线学习问题，必要时分步骤说明。你只能提供学习建议；不能访问内部 OA、审批、人员资料或执行机器人及其他工具。不要声称已经完成外部操作。';

function boundedText(value, maxBytes, maxChars = 12000) {
  if (typeof value !== 'string') return '';
  let result = value.trim();
  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  }
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = Buffer.from(result, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
  }
  return result;
}

export function buildChatBody({ text, history = [] }) {
  const input = boundedText(text, 20000);
  if (!input) throw new Error('Empty chat input');
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  // The deployed public API accepts user/assistant only. Its own server prompt
  // remains authoritative; this public-course hint uses the supported contract.
  const messages = [{ role: 'user', content: COURSE_PROMPT }];
  for (const message of recent) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    const content = boundedText(message.content ?? message.text, 10000);
    if (content) messages.push({ role: message.role, content });
  }
  messages.push({ role: 'user', content: input });
  const body = JSON.stringify({ topic: 'student', messages });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Chat request too large');
  return body;
}

export function validatedFinal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid final response');
  if (value.provider !== 'bailian' || value.fallbackReason || /fallback|error|draft|retrieval/i.test(String(value.mode ?? ''))) {
    throw new Error('Unconfirmed model response');
  }
  const answer = typeof value.answer === 'string' ? value.answer.trim() : '';
  if (!answer || Buffer.byteLength(answer, 'utf8') > MAX_FINAL_BYTES) throw new Error('Invalid final answer');
  return answer;
}

async function readBounded(response, signal) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new Error('Model response too large');
  if (!response.body) throw new Error('Empty model response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Model response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function parseFinalSse(raw) {
  let final;
  let sawError = false;
  const normalized = raw.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  // A trailing frame without its blank line was never dispatched by SSE.
  const trailing = blocks.pop();
  if (trailing.trim()) throw new Error('Truncated model stream');
  for (const block of blocks) {
    if (block.split('\n').some((line) => /^event:\s*error\s*$/.test(line))) sawError = true;
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') continue;
    let message;
    try { message = JSON.parse(data); } catch { throw new Error('Malformed model stream'); }
    if (message?.type === 'error') sawError = true;
    if (message?.type === 'final') {
      if (final !== undefined) throw new Error('Duplicate final response');
      final = message.data;
    }
  }
  if (sawError || final === undefined) throw new Error('Model stream not confirmed');
  return validatedFinal(final);
}

export function createChatAnswer({ fetchImpl = fetch, timeoutMs = 90000, onError = () => {} } = {}) {
  return async function answer({ text, history, signal: callerSignal }) {
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: CHAT_ORIGIN, accept: 'application/json, text/event-stream' },
        body: buildChatBody({ text, history }),
        credentials: 'omit',
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw new Error('Model request failed');
      const raw = await readBounded(response, signal);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) return parseFinalSse(raw);
      if (!contentType.includes('application/json')) throw new Error('Unexpected model response');
      return validatedFinal(JSON.parse(raw));
    } catch {
      // Never log model payloads, user text, identifiers, or credentials.
      try { onError('chat_request_failed'); } catch {}
      return FAILURE_TEXT;
    }
  };
}

export { FAILURE_TEXT, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES };
