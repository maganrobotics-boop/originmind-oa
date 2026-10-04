// Run once against the current Chat DB after its SQLite backup; safe to rerun.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function migrateFutureHonors(databasePath, root) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const schema = readFileSync(path.join(root, 'chat-cloudflare/migrations/0008_learning_honors.sql'), 'utf8').split('-- Preserve the IDs')[0];
  const registry = JSON.parse(readFileSync(path.join(root, 'aliyun/learning/newbie-honors.json'), 'utf8'));
  if (!Array.isArray(registry.awards)) throw new Error('Existing honor registry unavailable');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_honors'").get();
    if (!existing) db.exec(schema);
    const insert = db.prepare('INSERT OR IGNORE INTO learning_honors (id,recipient_name,recipient_email,category,title,message,source_kind,source_reference,granted_by,granted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const event = db.prepare("INSERT OR IGNORE INTO learning_honor_events(honor_id,version,action,actor,occurred_at,note) VALUES(?,1,'import','migration:oa-future-stars',?,?)");
    let imported = 0;
    for (const row of registry.awards) {
      if (!/^[a-z0-9-]{10,64}$/u.test(row.id || '') || !row.name || !row.title || !/^[^\s@]+@[^\s@]+$/u.test(row.email || '') || !Number.isSafeInteger(row.issuedAt)) throw new Error('Invalid existing honor record');
      const source = '马淦于2026-10-04明确确认通关；沿用现网既有荣誉 ID、授予时间和此前已核验的账户绑定。';
      const now = Date.now();
      const change = insert.run(row.id, row.name, row.email.toLowerCase(), 'newbie', row.title, row.message || '', 'manual_confirmation', source, 'import:owner-confirmed-20261004', row.issuedAt, now);
      if (change.changes) { imported++; event.run(row.id, now, source); }
      const saved = db.prepare('SELECT recipient_email,name FROM (SELECT recipient_email,recipient_name AS name FROM learning_honors WHERE id=?)').get(row.id);
      if (!saved?.recipient_email || saved.name !== row.name) throw new Error('Existing honor binding needs explicit migration review');
    }
    db.exec('COMMIT');
    const total = db.prepare('SELECT COUNT(*) AS n FROM learning_honors').get().n;
    return { imported, total, preservedBindings: registry.awards.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(migrateFutureHonors(process.env.CHAT_SQLITE_PATH || '/var/lib/originmind-chat/chat.sqlite', root)));
}
