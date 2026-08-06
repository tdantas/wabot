const { sql } = require('./db')

async function save(messageId, groupId, sender, command, query) {
  await sql`
    INSERT INTO pending_requests (message_id, group_id, sender, command, query, expires_at)
    VALUES (${messageId}, ${groupId}, ${sender}, ${command}, ${query}, NOW() + INTERVAL '5 minutes')
  `
}

async function get(messageId) {
  const [row] = await sql`
    SELECT * FROM pending_requests
    WHERE message_id = ${messageId} AND expires_at > NOW()
  `
  return row || null
}

async function del(messageId) {
  await sql`DELETE FROM pending_requests WHERE message_id = ${messageId}`
}

async function purgeExpired() {
  const result = await sql`DELETE FROM pending_requests WHERE expires_at <= NOW()`
  return result.count
}

module.exports = { save, get, del, purgeExpired }
