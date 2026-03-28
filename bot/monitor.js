const { open } = require('./db')

const INTERVAL = parseInt(process.env.MONITOR_INTERVAL, 10) || 5000

let db
let upsert

function start() {
  db = open()
  upsert = db.prepare(`
    INSERT INTO bot_metrics (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `)

  let lastCheck = process.hrtime.bigint()

  setInterval(() => {
    const now = process.hrtime.bigint()
    const elapsed = Number(now - lastCheck) / 1e6
    const lag = Math.max(0, elapsed - INTERVAL)
    lastCheck = now

    const mem = process.memoryUsage()

    const metrics = {
      rss: (mem.rss / 1024 / 1024).toFixed(1),
      heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
      heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(1),
      external: (mem.external / 1024 / 1024).toFixed(1),
      eventLoopLag: lag.toFixed(1),
      uptime: Math.floor(process.uptime()),
    }

    try {
      upsert.run('bot_metrics', JSON.stringify(metrics))
    } catch (_) {}
  }, INTERVAL).unref()
}

module.exports = { start }
