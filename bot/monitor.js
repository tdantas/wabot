const { sql } = require('./db')

const INTERVAL = parseInt(process.env.MONITOR_INTERVAL, 10) || 5000

// Estado da ligação ao WhatsApp, publicado junto das métricas. Sem isto, uma
// sessão expirada (logout 401) é invisível: o processo continua vivo e os
// números de memória continuam a atualizar enquanto o bot está surdo.
let wa = { connection: 'connecting', since: Date.now(), loggedOut: false }

function setStatus(patch) {
  wa = { ...wa, ...patch, since: Date.now() }
}

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
      wa: { ...wa, sinceSec: Math.floor((Date.now() - wa.since) / 1000) },
    }

    try {
      await sql`
        INSERT INTO bot_metrics (key, value, updated_at) VALUES ('bot_metrics', ${JSON.stringify(metrics)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `
    } catch (_) {}
  }, INTERVAL).unref()
}

module.exports = { start, setStatus }
