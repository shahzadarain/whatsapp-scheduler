const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'scheduler.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient      TEXT NOT NULL,
    chat_type      TEXT NOT NULL DEFAULT 'individual',
    message_type   TEXT NOT NULL DEFAULT 'text',
    message_text   TEXT NOT NULL DEFAULT '',
    media_path     TEXT,
    media_mimetype TEXT,
    media_filename TEXT,
    send_at        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    recurrence     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    sent_at        TEXT,
    error_message  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_status_send_at
    ON messages(status, send_at);
`);

migrateAddColumn('message_type', "TEXT NOT NULL DEFAULT 'text'");
migrateAddColumn('media_path', 'TEXT');
migrateAddColumn('media_mimetype', 'TEXT');
migrateAddColumn('media_filename', 'TEXT');

function migrateAddColumn(name, defSql) {
  const cols = db.prepare("PRAGMA table_info(messages)").all().map((r) => r.name);
  if (!cols.includes(name)) {
    db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${defSql}`);
  }
}

const stmts = {
  insert: db.prepare(`
    INSERT INTO messages (
      recipient, chat_type, message_type, message_text,
      media_path, media_mimetype, media_filename,
      send_at, recurrence, status
    ) VALUES (
      @recipient, @chat_type, @message_type, @message_text,
      @media_path, @media_mimetype, @media_filename,
      @send_at, @recurrence, 'pending'
    )
  `),
  update: db.prepare(`
    UPDATE messages
       SET recipient      = @recipient,
           chat_type      = @chat_type,
           message_type   = @message_type,
           message_text   = @message_text,
           media_path     = @media_path,
           media_mimetype = @media_mimetype,
           media_filename = @media_filename,
           send_at        = @send_at,
           recurrence     = @recurrence
     WHERE id = @id
  `),
  delete: db.prepare(`DELETE FROM messages WHERE id = ?`),
  getById: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  list: db.prepare(`SELECT * FROM messages ORDER BY send_at DESC`),
  listPending: db.prepare(`
    SELECT * FROM messages
     WHERE status = 'pending' AND send_at <= ?
     ORDER BY send_at ASC
  `),
  listHistory: db.prepare(`
    SELECT * FROM messages
     WHERE status IN ('sent', 'failed')
     ORDER BY COALESCE(sent_at, send_at) DESC
     LIMIT 200
  `),
  markSent: db.prepare(`
    UPDATE messages
       SET status = 'sent',
           sent_at = ?,
           error_message = NULL
     WHERE id = ?
  `),
  markFailed: db.prepare(`
    UPDATE messages
       SET status = 'failed',
           error_message = ?
     WHERE id = ?
  `),
  reschedule: db.prepare(`
    UPDATE messages
       SET status = 'pending',
           send_at = ?,
           sent_at = NULL,
           error_message = NULL
     WHERE id = ?
  `),
  countByMediaPath: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE media_path = ?`)
};

function emptyMedia() {
  return { media_path: null, media_mimetype: null, media_filename: null };
}

function withMediaDefaults(data) {
  return {
    media_path: data.media_path ?? null,
    media_mimetype: data.media_mimetype ?? null,
    media_filename: data.media_filename ?? null,
    message_type: data.message_type ?? 'text',
    ...data
  };
}

function createMessage(data) {
  const row = withMediaDefaults({ ...emptyMedia(), ...data });
  const result = stmts.insert.run(row);
  return getMessage(result.lastInsertRowid);
}

function updateMessage(id, data) {
  const row = withMediaDefaults({ ...emptyMedia(), ...data });
  stmts.update.run({ ...row, id });
  return getMessage(id);
}

function deleteMessage(id) {
  return stmts.delete.run(id).changes > 0;
}

function getMessage(id) {
  return stmts.getById.get(id);
}

function listMessages() {
  return stmts.list.all();
}

function listPendingDue(nowIso) {
  return stmts.listPending.all(nowIso);
}

function listHistory() {
  return stmts.listHistory.all();
}

function markSent(id, sentAtIso) {
  stmts.markSent.run(sentAtIso, id);
}

function markFailed(id, errorMessage) {
  stmts.markFailed.run(errorMessage, id);
}

function reschedule(id, nextSendAtIso) {
  stmts.reschedule.run(nextSendAtIso, id);
}

function countByMediaPath(mediaPath) {
  if (!mediaPath) return 0;
  return stmts.countByMediaPath.get(mediaPath).n;
}

module.exports = {
  db,
  createMessage,
  updateMessage,
  deleteMessage,
  getMessage,
  listMessages,
  listPendingDue,
  listHistory,
  markSent,
  markFailed,
  reschedule,
  countByMediaPath
};
