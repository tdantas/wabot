const { sql } = require('./db')

const INTERVAL = parseInt(process.env.MONITOR_INTERVAL, 10) || 5000

function start() {
  let lastCheck = process.hrtime.bigint()

  setInterval(async () => {
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
      await sql`
        INSERT INTO bot_metrics (key, value, updated_at) VALUES ('bot_metrics', ${JSON.stringify(metrics)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `
    } catch (_) {}
  }, INTERVAL).unref()
}

module.exports = { start }
