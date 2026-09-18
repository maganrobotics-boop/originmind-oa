/** Opt-in production workbench checks. Never read member data or print secrets. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeTaskDiagnostic } from '../lib/ai-workbench-diagnostics.mjs';

export const TASK_MIGRATIONS = Object.freeze({
  '0002_ai_workbench.sql': 'e9343e0f36d1666f18868745b9046837a82e0ca8549d93057452c72fc420ca27',
  '0003_ai_workbench_artifacts.sql': '393f96ef5cba7caced716412e074cbb8c207cd40d9cc222097dfabc3df6cdb92',
});
export const TASK_SCHEMA_QUERY = "SELECT type,name,sql FROM sqlite_master WHERE (name GLOB 'ai_workbench_*' OR tbl_name GLOB 'ai_workbench_*') AND name NOT GLOB 'sqlite_*' ORDER BY type,name";
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), details); };
// Only these fixed labels and numeric HTTP statuses may leave this process.
// Never serialize an exception, URL, headers, response body, SQL, or stack.
const FAILURE_CODES = new Set([
  'TASK_MIGRATION_MANIFEST', 'TASK_MIGRATION_FILE', 'TASK_MIGRATION_HASH',
  'TASK_SCHEMA_RESPONSE', 'TASK_SCHEMA_DRIFT', 'TASK_SCHEMA_INCOMPLETE',
  'TASK_PROBE_HTTP', 'TASK_PROBE_TOO_LARGE', 'TASK_PROBE_JSON', 'TASK_PROBE_SECRET',
  'TASK_PROBE_INCOMPLETE', 'TASK_PROBE_ARTIFACT', 'TASK_PROBE_AUTHORIZATION',
  'TASK_PROBE_TRANSPORT', 'TASK_PROBE_TIMEOUT', 'TASK_RELEASE_MODE',
]);
const SERVICE_ERRORS = new Map([
  ['接口不可用', 'route_unavailable'],
  ['请求格式不正确', 'invalid_format'],
  ['服务认证失败或请求过大', 'authentication_or_size_rejected'],
  ['仅限已授权的 OA 服务', 'authentication_rejected'],
  ['请求内容不正确', 'invalid_payload'],
  ['任务需要已配置的百炼模型', 'bailian_not_configured'],
  ['任务未生成完整可用成果', 'result_incomplete'],
  ['问答服务暂不可用，请稍后重试', 'service_unavailable'],
]);
const SERVICE_CODES = new Set(SERVICE_ERRORS.values());
const RESPONSE_KINDS = new Set(['json', 'non_json', 'empty', 'invalid_json']);
const IO_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOSPC']);
export function releaseFailureDiagnostic(error, phase) {
  const code = FAILURE_CODES.has(error?.message) ? error.message
    : IO_CODES.has(error?.code) ? 'TASK_RELEASE_IO' : 'TASK_RELEASE_UNKNOWN';
  const result = { verified: false, phase: ['probe', 'manifest', 'before', 'after'].includes(phase) ? phase : 'unknown', code };
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) result.httpStatus = error.httpStatus;
  if (SERVICE_CODES.has(error?.serviceCode)) result.serviceCode = error.serviceCode;
  if (RESPONSE_KINDS.has(error?.responseKind)) result.responseKind = error.responseKind;
  if (IO_CODES.has(error?.code)) result.ioCode = error.code;
  const taskDiagnostic = sanitizeTaskDiagnostic(error?.taskDiagnostic);
  if (taskDiagnostic) result.taskDiagnostic = taskDiagnostic;
  return result;
}
const normalizeSql = value => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').replace(/;$/u, '') : '';
export async function reviewedTaskSql(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(TASK_MIGRATIONS))) fail('TASK_MIGRATION_MANIFEST');
  const result = {};
  for (const [name, expectedHash] of Object.entries(TASK_MIGRATIONS)) {
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail('TASK_MIGRATION_FILE');
    const bytes = await readFile(path);
    if (hash(bytes) !== expectedHash) fail('TASK_MIGRATION_HASH');
    result[name] = bytes.toString('utf8');
  }
  return result;
}
export function expectedTaskSchema(sqlByName) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE members(id TEXT PRIMARY KEY)');
    for (const name of Object.keys(TASK_MIGRATIONS)) {
      if (typeof sqlByName[name] !== 'string' || hash(sqlByName[name]) !== TASK_MIGRATIONS[name]) fail('TASK_MIGRATION_HASH');
      db.exec(sqlByName[name]);
    }
    return Object.fromEntries(db.prepare(TASK_SCHEMA_QUERY).all().map(row => [`${row.type}:${row.name}`, normalizeSql(row.sql)]));
  } finally { db.close(); }
}
export function checkTaskSchema(phase, payload, definitions) {
  if (!['before', 'after'].includes(phase) || !Array.isArray(payload) || payload.length !== 1
    || payload[0]?.success !== true || !Array.isArray(payload[0].results)) fail('TASK_SCHEMA_RESPONSE');
  const rows = payload[0].results, seen = new Set();
  for (const row of rows) {
    const key = `${row.type}:${row.name}`;
    if (seen.has(key) || !Object.hasOwn(definitions, key) || normalizeSql(row.sql) !== definitions[key]) fail('TASK_SCHEMA_DRIFT');
    seen.add(key);
  }
  if (phase === 'after' && seen.size !== Object.keys(definitions).length) fail('TASK_SCHEMA_INCOMPLETE');
  return { phase, verified: true, objects: [...seen].sort(), missing: Object.keys(definitions).filter(key => !seen.has(key)).sort() };
}
async function boundedJson(response) {
  const httpStatus = response.status;
  if (!response.body) fail('TASK_PROBE_HTTP', { httpStatus, responseKind: 'empty' });
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body.cancel().catch(() => {});
    fail('TASK_PROBE_HTTP', { httpStatus, responseKind: 'non_json' });
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 262144) fail('TASK_PROBE_TOO_LARGE', { httpStatus });
      chunks.push(value);
    }
  } catch (error) {
    if (error?.message === 'TASK_PROBE_TOO_LARGE') throw error;
    fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TASK_PROBE_TIMEOUT' : 'TASK_PROBE_TRANSPORT', { httpStatus });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail(response.ok ? 'TASK_PROBE_JSON' : 'TASK_PROBE_HTTP', { httpStatus, responseKind: 'invalid_json' }); }
  if (!response.ok) {
    // Map exact, known service messages to fixed labels; never print the message.
    fail('TASK_PROBE_HTTP', { httpStatus, responseKind: 'json', serviceCode: SERVICE_ERRORS.get(result?.error),
      taskDiagnostic: sanitizeTaskDiagnostic(result?.diagnostic) });
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('TASK_PROBE_JSON', { httpStatus });
  return result;
}
async function compileAndVerify(title, answer) {
  const { prepareTaskArtifacts, verifiedArtifactBytes } = await import('../lib/ai-workbench-artifacts.mjs');
  const { artifacts } = await prepareTaskArtifacts(title, answer);
  for (const artifact of artifacts) await verifiedArtifactBytes(artifact);
  return artifacts.map(({ format, byte_size, sha256 }) => ({ format, byte_size, sha256 }));
}
export async function probeTaskTools(secret, fetcher = fetch, compile = compileAndVerify) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret || '')) fail('TASK_PROBE_SECRET');
  const task = {
    kind: 'document', title: 'AI 工作台上线自检（合成材料）',
    instruction: '把材料整理成简短报告，分为已完成、待办、待补充。只依据材料，不编造事实，直接制作完整文档。',
    material: '此为上线前合成测试，不代表真实项目进展。接口联调已完成；实机验收尚未开展。负责人和日期尚未提供。',
  };
  const path = '/api/internal/oa-answer', body = JSON.stringify({ operation: 'task', task });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
  const signature = createHmac('sha256', secret).update(`oa-chat-bridge/v1\nPOST\n${path}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
  let response;
  try {
    // Return redirect status for diagnosis, but never follow it with the HMAC.
    response = await fetcher(`https://chat.omindos.ai${path}`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-oa-chat-time': timestamp,
        'x-oa-chat-nonce': nonce, authorization: `OA-HMAC ${signature}` }, body, signal: AbortSignal.timeout(70000) });
  } catch (error) {
    fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TASK_PROBE_TIMEOUT' : 'TASK_PROBE_TRANSPORT');
  }
  const result = await boundedJson(response), execution = result.execution;
  if (result.received !== true || result.provider !== 'bailian' || result.mode !== 'task'
    || execution?.version !== 1 || execution.state !== 'prepared'
    || !Number.isInteger(execution.modelCalls) || execution.modelCalls < 1 || execution.modelCalls > 6
    || !Array.isArray(execution.steps) || execution.steps.some(step => !step || !['read_material', 'search_material', 'table_statistics', 'prepare_document'].includes(step.tool))
    || !execution.steps.some(step => step?.tool === 'prepare_document' && step.status === 'ok')
    || !execution.steps.some(step => ['read_material', 'search_material', 'table_statistics'].includes(step?.tool) && step.status === 'ok')
    || typeof result.answer !== 'string' || result.answer.length < 10 || result.answer.length > 18000) fail('TASK_PROBE_INCOMPLETE');
  let artifacts;
  try { artifacts = await compile(task.title, result.answer); }
  catch { fail('TASK_PROBE_ARTIFACT'); }
  if (!Array.isArray(artifacts) || artifacts.some(item => !item || typeof item !== 'object')
    || JSON.stringify(artifacts.map(item => item.format)) !== '["md","docx"]'
    || artifacts.some(item => !Number.isInteger(item.byte_size) || item.byte_size < 1 || item.byte_size > 1000000 || !/^[a-f0-9]{64}$/u.test(item.sha256))) fail('TASK_PROBE_ARTIFACT');
  return { verified: true, syntheticMaterial: true, provider: 'bailian', modelCalls: execution.modelCalls,
    tools: execution.steps.filter(step => step.status === 'ok').map(step => step.tool), artifacts,
    memberSessionTested: false, oaTaskPersistenceTested: false };
}
async function main() {
  const [mode, directory, input, output] = process.argv.slice(2);
  if (mode === 'probe') {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.OA_PRODUCTION_ENABLE_AI_WORKBENCH !== 'true') fail('TASK_PROBE_AUTHORIZATION');
    const receipt = await probeTaskTools(process.env.PUBLIC_LAB_AI_SERVICE_TOKEN);
    await writeFile(directory, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  const definitions = expectedTaskSchema(await reviewedTaskSql(directory));
  if (mode === 'manifest') {
    await writeFile(input, `${JSON.stringify({ enabledByExplicitDispatch: true, variables: { OA_AI_TASKS_ENABLED: 'true' }, migrations: TASK_MIGRATIONS }, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  if (!['before', 'after'].includes(mode)) fail('TASK_RELEASE_MODE');
  const receipt = checkTaskSchema(mode, JSON.parse(await readFile(input, 'utf8')), definitions);
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    const phase = process.argv[2], diagnostic = releaseFailureDiagnostic(error, phase);
    console.error(`OA_WORKBENCH_RELEASE_CHECK_FAILED ${JSON.stringify(diagnostic)}`);
    // The release artifact already collects this directory. The failure receipt
    // is new, private, and never overwrites an earlier successful probe receipt.
    if (phase === 'probe' && process.argv[3]) {
      try { await writeFile(`${process.argv[3]}.failure.json`, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
      catch { console.error('OA_WORKBENCH_DIAGNOSTIC_RECEIPT_NOT_SAVED'); }
    }
    process.exitCode = 1;
  });
}
