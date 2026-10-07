import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

function fault(code) { const e = new Error(code); e.code = code; return e; }
function safeId(value, limit = 128) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && !/[\u0000-\u001f]/.test(value);
}
function messageKey(openKfId, id) { return createHash('sha256').update(`${openKfId}\0${id}`).digest('hex'); }

export function createStore(path, { enabledAt = Date.now(), openKfId, maxQueue = 1000 } = {}) {
  if (!safeId(openKfId) || !Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 10000 || !Number.isFinite(enabledAt)) throw fault('STORE_CONFIG');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signals (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, open_kfid TEXT NOT NULL,
      text TEXT NOT NULL, send_time INTEGER NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_retry INTEGER NOT NULL DEFAULT 0,
      answer TEXT, error_code TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status,next_retry,send_time);
    CREATE INDEX IF NOT EXISTS inbox_user ON inbox(user_id,send_time);
    CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (
      message_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL, part INTEGER NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error_code TEXT, accepted_at INTEGER,
      UNIQUE(inbox_id,part));
    CREATE TABLE IF NOT EXISTS quotas (
      user_id TEXT PRIMARY KEY, latest_id TEXT NOT NULL, latest_time INTEGER NOT NULL,
      sent_count INTEGER NOT NULL DEFAULT 0);
  `);
  if (!db.prepare('PRAGMA table_info(outbox)').all().some((column) => column.name === 'accepted_at')) db.exec('ALTER TABLE outbox ADD COLUMN accepted_at INTEGER');
  const meta = (key) => db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
  const oldKfId = meta('open_kfid');
  if (oldKfId && oldKfId !== openKfId) { db.close(); throw fault('STORE_ACCOUNT_MISMATCH'); }
  db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('open_kfid', openKfId);
  db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('enabled_at', String(Math.floor(enabledAt)));
  const activeSince = Number(meta('enabled_at'));
  // A crash after preparing a reply reuses its outbox; it never calls the model again.
  db.exec("UPDATE inbox SET status='pending' WHERE status='processing'");

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function backlogCount() {
    return db.prepare("SELECT count(*) AS n FROM inbox WHERE status IN ('pending','processing')").get().n;
  }

  const store = {
    enabledAt: activeSince,
    openKfId,
    maxQueue,
    close() { db.close(); },
    saveSignal(token, now = Date.now()) {
      if (!safeId(token)) throw fault('SIGNAL_INVALID');
      transaction(() => {
        db.prepare('INSERT INTO signals VALUES (?,?) ON CONFLICT(token) DO UPDATE SET created_at=excluded.created_at').run(token, now);
        db.exec('DELETE FROM signals WHERE token NOT IN (SELECT token FROM signals ORDER BY created_at DESC LIMIT 32)');
      });
    },
    latestSignal() { return db.prepare('SELECT token,created_at AS createdAt FROM signals ORDER BY created_at DESC LIMIT 1').get(); },
    clearSignal(token) { db.prepare('DELETE FROM signals WHERE token=?').run(token); },
    cursor() { return meta('cursor') || ''; },
    backlogCount,
    capacity() { return Math.max(0, maxQueue - backlogCount()); },
    ingestBatch({ cursor, messages, now = Date.now() }) {
      if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > 64 || !Array.isArray(messages) || messages.length > 1000) throw fault('SYNC_INVALID');
      return transaction(() => {
        let accepted = 0;
        let ignored = 0;
        for (const message of messages) {
          if (!message || typeof message !== 'object' || !safeId(message.msgid, 256)) { ignored++; continue; }
          const id = messageKey(openKfId, message.msgid);
          if (db.prepare('SELECT 1 FROM seen WHERE id=?').get(id)) continue;
          db.prepare('INSERT INTO seen VALUES (?,?)').run(id, now);
          if (message.msgtype === 'event') {
            const event = message.event;
            if (event?.event_type === 'msg_send_fail' && event.open_kfid === openKfId && safeId(event.fail_msgid, 32)) {
              const outgoing = db.prepare('SELECT inbox_id FROM outbox WHERE message_id=?').get(event.fail_msgid);
              const failure = `KF_SEND_FAIL_${Number.isInteger(event.fail_type) ? event.fail_type : 0}`;
              db.prepare("UPDATE outbox SET status='failed',error_code=? WHERE message_id=?").run(failure, event.fail_msgid);
              if (outgoing) db.prepare("UPDATE inbox SET status='failed',error_code=? WHERE id=?").run(failure, outgoing.inbox_id);
            }
            ignored++; continue;
          }
          if (message.open_kfid !== openKfId || message.origin !== 3 || !safeId(message.external_userid)
              || !Number.isSafeInteger(message.send_time) || message.send_time <= 0
              || message.send_time * 1000 < activeSince || message.send_time * 1000 > now + 300000) { ignored++; continue; }
          const userId = message.external_userid;
          const quota = db.prepare('SELECT latest_time FROM quotas WHERE user_id=?').get(userId);
          if (!quota || message.send_time >= quota.latest_time) {
            // A question can reach WeChat while the previous answer is being
            // generated. Its allowance has already started even if we only
            // discover that question in the next sync page.
            const alreadySent = db.prepare(`SELECT count(*) AS n FROM outbox o JOIN inbox i ON i.id=o.inbox_id
              WHERE i.user_id=? AND o.accepted_at>=?`).get(userId, message.send_time * 1000).n;
            db.prepare(`INSERT INTO quotas VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE
              SET latest_id=excluded.latest_id,latest_time=excluded.latest_time,sent_count=excluded.sent_count`).run(userId, id, message.send_time, alreadySent);
          }
          if (message.msgtype !== 'text' || typeof message.text?.content !== 'string' || !message.text.content.trim()
              || Buffer.byteLength(message.text.content) > 30000) { ignored++; continue; }
          if (backlogCount() >= maxQueue) throw fault('QUEUE_FULL');
          db.prepare(`INSERT INTO inbox(id,user_id,open_kfid,text,send_time,status,created_at)
            VALUES (?,?,?,?,?,'pending',?)`).run(id, userId, openKfId, message.text.content, message.send_time, now);
          accepted++;
        }
        // Cursor and receipt are a single commit; a rollback replays the same page safely.
        db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('cursor', cursor);
        return { accepted, ignored };
      });
    },
    listPending(limit = 2, now = Date.now()) {
      return db.prepare(`SELECT i.id,i.user_id AS userId,i.text,i.send_time AS sendTime,i.answer,i.attempts
        FROM inbox i WHERE i.status='pending' AND i.next_retry<=? AND NOT EXISTS (
          SELECT 1 FROM inbox earlier WHERE earlier.user_id=i.user_id AND earlier.status IN ('pending','processing')
          AND (earlier.send_time<i.send_time OR (earlier.send_time=i.send_time AND earlier.rowid<i.rowid)))
        ORDER BY i.send_time,i.rowid LIMIT ?`).all(now, limit);
    },
    claim(id) { return db.prepare("UPDATE inbox SET status='processing' WHERE id=? AND status='pending'").run(id).changes === 1; },
    skip(id, code) {
      transaction(() => {
        db.prepare("UPDATE inbox SET status='skipped',error_code=? WHERE id=?").run(code, id);
        db.prepare("UPDATE outbox SET status='cancelled',error_code=? WHERE inbox_id=? AND status='pending'").run(code, id);
      });
    },
    prepareAnswer(id, answer, chunks) {
      if (typeof answer !== 'string' || !answer || !Array.isArray(chunks) || chunks.length < 1 || chunks.length > 4
          || chunks.some((text) => typeof text !== 'string' || !text || Buffer.byteLength(text) > 2048)) throw fault('ANSWER_INVALID');
      transaction(() => {
        const message = db.prepare('SELECT answer FROM inbox WHERE id=?').get(id);
        if (!message) throw fault('MESSAGE_MISSING');
        if (message.answer !== null) return;
        db.prepare('UPDATE inbox SET answer=? WHERE id=?').run(answer, id);
        chunks.forEach((text, part) => {
          const messageId = createHash('sha256').update(`${id}\0${part}`).digest('hex').slice(0, 32);
          db.prepare('INSERT INTO outbox(message_id,inbox_id,part,text) VALUES (?,?,?,?)').run(messageId, id, part, text);
        });
      });
    },
    outbox(id) { return db.prepare('SELECT message_id AS messageId,part,text,status FROM outbox WHERE inbox_id=? ORDER BY part').all(id); },
    quota(userId, now = Date.now()) {
      const row = db.prepare('SELECT latest_time AS latestTime,sent_count AS sentCount FROM quotas WHERE user_id=?').get(userId);
      if (!row || now >= (row.latestTime + 48 * 3600) * 1000) return 0;
      return Math.max(0, 5 - row.sentCount);
    },
    markSent(messageId, now = Date.now()) {
      transaction(() => {
        const row = db.prepare(`SELECT o.status,i.user_id AS userId FROM outbox o
          JOIN inbox i ON i.id=o.inbox_id WHERE o.message_id=?`).get(messageId);
        if (row?.status !== 'pending') return;
        db.prepare("UPDATE outbox SET status='accepted',accepted_at=? WHERE message_id=?").run(now, messageId);
        db.prepare('UPDATE quotas SET sent_count=sent_count+1 WHERE user_id=?').run(row.userId);
      });
    },
    done(id) { db.prepare("UPDATE inbox SET status='done',error_code=NULL WHERE id=?").run(id); },
    retry(id, code = 'PROCESS_FAILED', now = Date.now(), retryable = true) {
      const row = db.prepare('SELECT attempts FROM inbox WHERE id=?').get(id);
      if (!row) return;
      const attempts = row.attempts + 1;
      db.prepare('UPDATE inbox SET status=?,attempts=?,error_code=?,next_retry=? WHERE id=?')
        .run(retryable && attempts < 6 ? 'pending' : 'failed', attempts, String(code).replace(/[^A-Z0-9_-]/g, '').slice(0, 80), now + Math.min(60000, 2000 * 2 ** (attempts - 1)), id);
    },
    getHistory(userId, limit = 6) {
      const rows = db.prepare(`SELECT text,answer FROM inbox WHERE user_id=? AND status='done'
        ORDER BY send_time DESC,rowid DESC LIMIT ?`).all(userId, Math.max(0, Math.min(20, limit)));
      return rows.reverse().flatMap((row) => [{ role: 'user', content: row.text }, { role: 'assistant', content: row.answer }]);
    },
    statusCounts() { return db.prepare('SELECT status,count(*) AS count FROM inbox GROUP BY status').all(); },
  };
  return Object.freeze(store);
}
