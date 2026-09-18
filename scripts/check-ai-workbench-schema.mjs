/** Read-only schema planning for the explicitly authorized OA activation. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const TASK_MIGRATIONS = Object.freeze(['0002_ai_workbench.sql', '0003_ai_workbench_artifacts.sql']);
export const TASK_SCHEMA_QUERY = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'ai_workbench_*' AND sql IS NOT NULL ORDER BY type,name";
const expectedNames = ['ai_workbench_artifacts', 'ai_workbench_feishu_inbox', 'ai_workbench_owner', 'ai_workbench_queue', 'ai_workbench_tasks'];
const normalize = sql => sql.split(/('(?:''|[^'])*'|"(?:""|[^"])*")/u)
  .map((part, index) => index % 2 ? part : part.replace(/\bIF\s+NOT\s+EXISTS\s+/giu, '').replace(/\s+/gu, ' ')).join('').trim();

export function loadExpectedSchema(directory) {
  const dir = realpathSync(directory), db = new DatabaseSync(':memory:');
  const hashes = {};
  try {
    for (const name of TASK_MIGRATIONS) {
      const path = resolve(dir, name);
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || dirname(realpathSync(path)) !== dir) throw new Error('Unsafe task migration path');
      const sql = readFileSync(path, 'utf8');
      // Do not turn this additive activation into a general SQL executor.
      const statements = sql.replace(/--[^\n]*/gu, '').split(';').map(s => s.trim()).filter(Boolean);
      if (!statements.length || statements.some(s => !/^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+ai_workbench_[a-z_]+\s*(?:\(|ON\s+ai_workbench_[a-z_]+\s*\()/iu.test(s))) throw new Error('Task activation accepts additive task DDL only');
      hashes[name] = createHash('sha256').update(sql).digest('hex');
      db.exec(sql);
    }
    const objects = db.prepare(TASK_SCHEMA_QUERY).all().map(row => ({ ...row }));
    if (objects.map(row => row.name).sort().join(',') !== expectedNames.join(',')) throw new Error('Unexpected task migration objects');
    return { objects, hashes };
  } finally { db.close(); }
}

export function extractSchema(payload) {
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true || !Array.isArray(payload[0]?.results)) throw new Error('Invalid task schema response');
  return payload[0].results;
}

export function inspectTaskSchema(rows, expected, requireComplete = false) {
  if (!Array.isArray(rows)) throw new Error('Invalid task schema rows');
  const wanted = new Map(expected.objects.map(row => [row.name, row]));
  const found = new Set();
  for (const row of rows) {
    const target = wanted.get(row?.name);
    if (!target || found.has(row.name) || typeof row.sql !== 'string' || row.type !== target.type || row.tbl_name !== target.tbl_name || normalize(row.sql) !== normalize(target.sql)) throw new Error('Task schema differs from the reviewed migrations; no activation');
    found.add(row.name);
  }
  const missing = [...wanted.keys()].filter(name => !found.has(name));
  if (requireComplete && missing.length) throw new Error('Task schema is incomplete; keep the workbench disabled');
  return { state: missing.length ? 'pending' : 'applied', missing, migration_sha256: expected.hashes };
}

export function main(argv) {
  const [phase, ...args] = argv;
  if (!['before', 'after'].includes(phase) || args.length !== 6) throw new Error('Usage: before|after --schema FILE --migrations-dir DIR --receipt FILE');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--schema', '--migrations-dir', '--receipt'].includes(args[i]) || Object.hasOwn(options, args[i]) || !args[i + 1]) throw new Error('Invalid schema checker arguments');
    options[args[i]] = args[i + 1];
  }
  const expected = loadExpectedSchema(options['--migrations-dir']);
  const report = inspectTaskSchema(extractSchema(JSON.parse(readFileSync(options['--schema'], 'utf8'))), expected, phase === 'after');
  writeFileSync(options['--receipt'], `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(report.state);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : 'Task schema verification failed'); process.exitCode = 65; }
}
