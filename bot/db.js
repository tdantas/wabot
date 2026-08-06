const postgres = require('postgres')
const fs = require('fs')
const path = require('path')

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

const sql = postgres(process.env.DATABASE_URL || 'postgres://wabot:wabot@localhost:5432/wabot', {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
})

async function init() {
  const log = require('./logger')

  await sql`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `

  const applied = new Set(
    (await sql`SELECT name FROM migrations`).map(r => r.name)
  )

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) continue

    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')

    if (content.trimStart().startsWith('-- no-transaction')) {
      const statements = content.split(/;\s*$/m).map(s => s.trim()).filter(Boolean)
      for (const stmt of statements) {
        await sql.unsafe(stmt)
      }
      await sql`INSERT INTO migrations (name) VALUES (${file})`
    } else {
      await sql.begin(async (tx) => {
        await tx.unsafe(content)
        await tx`INSERT INTO migrations (name) VALUES (${file})`
      })
    }

    log.info(`[migration] ${file} aplicada`)
  }
}

async function close() {
  await sql.end()
}

module.exports = { sql, init, close }
