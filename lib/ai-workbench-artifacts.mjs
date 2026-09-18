import { validTaskResult } from './ai-workbench-core.mjs';
import { taskDocx } from './ai-workbench-docx.mjs';

export const ARTIFACT_TYPES = Object.freeze({
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});
const MAX_ARTIFACT_BYTES = 1000000;
const encoder = new TextEncoder();
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
function encode(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

/** Real file-generation tools; no network, shell, or external-service access. */
export async function prepareTaskArtifacts(title, result) {
  if (typeof title !== 'string' || !title.trim() || title.length > 100 || !validTaskResult(result)) throw new Error('TASK_INVALID_RESULT');
  let body = result.replace(/\r\n?/gu, '\n').trim();
  if (body.split('\n')[0].trim() === `# ${title.trim()}`) body = body.split('\n').slice(1).join('\n').trim();
  if (body.length < 10) throw new Error('TASK_EMPTY_DOCUMENT');
  const markdown = `# ${title.trim()}\n\n${body}\n`;
  const compiled = { md: encoder.encode(markdown), docx: taskDocx(title.trim(), body) };
  const artifacts = [];
  for (const [format, bytes] of Object.entries(compiled)) {
    if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) throw new Error('TASK_ARTIFACT_TOO_LARGE');
    if (format === 'docx' && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error('TASK_INVALID_DOCX');
    artifacts.push({ format, content_base64: encode(bytes), byte_size: bytes.length, sha256: await digest(bytes) });
  }
  return { markdown, artifacts };
}

/** Return exactly the saved bytes, refusing corrupt or incomplete artifacts. */
export async function verifiedArtifactBytes(artifact) {
  if (!artifact || !Object.hasOwn(ARTIFACT_TYPES, artifact.format)
    || !Number.isSafeInteger(artifact.byte_size) || artifact.byte_size < 1 || artifact.byte_size > MAX_ARTIFACT_BYTES
    || typeof artifact.content_base64 !== 'string' || artifact.content_base64.length !== 4 * Math.ceil(artifact.byte_size / 3)
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(artifact.content_base64) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new Error('TASK_ARTIFACT_CORRUPT');
  }
  const bytes = Uint8Array.from(atob(artifact.content_base64), ch => ch.charCodeAt(0));
  if (bytes.length !== artifact.byte_size || await digest(bytes) !== artifact.sha256) throw new Error('TASK_ARTIFACT_CORRUPT');
  return bytes;
}
