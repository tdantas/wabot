const { open } = require('./db')

const db = open()

const insert = db.prepare(`
  INSERT INTO pending_requests (message_id, group_id, sender, command, query, expires_at)
  VALUES (?, ?, ?, ?, ?, datetime('now', '+5 minutes'))
`)

const select = db.prepare(`
  SELECT * FROM pending_requests
  WHERE message_id = ? AND expires_at > datetime('now')
`)

const remove = db.prepare('DELETE FROM pending_requests WHERE message_id = ?')

const cleanup = db.prepare("DELETE FROM pending_requests WHERE expires_at <= datetime('now')")

function save(messageId, groupId, sender, command, query) {
  insert.run(messageId, groupId, sender, command, query)
}

function get(messageId) {
  return select.get(messageId)
}

function del(messageId) {
  remove.run(messageId)
}

function purgeExpired() {
  const result = cleanup.run()
  return result.changes
}

module.exports = { save, get, del, purgeExpired }
