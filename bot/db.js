const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wabot.db')
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

function open(readonly = false) {
  const db = new Database(DB_PATH, { readonly })
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  return db
}

function init() {
  const db = open()

  // tabela de controle de migrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `)

  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((r) => r.name)
  )

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')

    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file)
    })()

    require('./logger').info(`[migration] ${file} aplicada`)
  }

  db.close()
}

module.exports = { open, init }
