const { open } = require('./db')

const db = open()

const upsert = db.prepare(`
  INSERT INTO contacts (jid, name, type) VALUES (?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET name = excluded.name, type = excluded.type
`)

const select = db.prepare('SELECT name FROM contacts WHERE jid = ?')

function typeFromJid(jid) {
  return jid.endsWith('@g.us') ? 'group' : 'person'
}

function set(jid, name) {
  if (!name) return
  upsert.run(jid, name, typeFromJid(jid))
}

function getName(jid) {
  const row = select.get(jid)
  return row?.name || jid.replace(/@s\.whatsapp\.net$/, '')
}

module.exports = { set, getName }
