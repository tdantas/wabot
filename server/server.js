const express = require('express')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')
const pino = require('pino')

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
})

const BOT_DIR = path.join(__dirname, '..', 'bot')
const DB_PATH = process.env.DB_PATH || path.join(BOT_DIR, 'wabot.db')
const CONFIG_PATH = path.join(BOT_DIR, 'config.json')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

const app = express()
app.set('etag', false)
const PORT = process.env.PORT || 3000

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    log.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start }, 'request')
  })
  next()
})

const TZ = process.env.TZ || 'Europe/Lisbon'

function todayStr() {
  return new Date().toLocaleString('en-CA', { timeZone: TZ, hour12: false }).split(', ')[0]
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toLocaleString('en-CA', { timeZone: TZ, hour12: false }).split(', ')[0]
}

function weekSunday() {
  const d = new Date()
  const localDate = new Date(d.toLocaleString('en-US', { timeZone: TZ }))
  const day = localDate.getDay()
  localDate.setDate(localDate.getDate() - day)
  return localDate.toLocaleString('en-CA', { timeZone: TZ, hour12: false }).split(', ')[0]
}

// lazy statements — tabela pode não existir se bot ainda não correu migrations
let _queryRange, _queryContact, _queryDaily, _queryUserDaily

function stmts() {
  if (!_queryRange) {
    _queryRange = db.prepare(`
      SELECT sender, SUM(count) as count FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY sender ORDER BY count DESC
      LIMIT 10
    `)
    _queryContact = db.prepare('SELECT name FROM contacts WHERE jid = ?')
    _queryDaily = db.prepare(`
      SELECT date, day_of_week, period, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY date, period ORDER BY date, period
    `)
    _queryUserDaily = db.prepare(`
      SELECT date, day_of_week, period, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND sender = ? AND date >= ? AND date <= ?
      GROUP BY date, period ORDER BY date, period
    `)
  }
  return { queryRange: _queryRange, queryContact: _queryContact, queryDaily: _queryDaily, queryUserDaily: _queryUserDaily }
}

function getName(jid) {
  const row = stmts().queryContact.get(jid)
  return row?.name || jid.replace(/@s\.whatsapp\.net$/, '')
}

app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json())

// --- lazy settings statements (direct DB, avoids requiring bot modules from server) ---
let _stmtGetGroups, _stmtGetDisabled, _stmtUpsertGroup, _stmtUpdateListening,
    _stmtUpdateTroll, _stmtInsertDisabled, _stmtDeleteDisabled, _stmtDeleteAllDisabled

function settingsStmts() {
  if (!_stmtGetGroups) {
    _stmtGetGroups = db.prepare(`
      SELECT gs.group_id, gs.listening, gs.troll_mode, c.name
      FROM group_settings gs
      LEFT JOIN contacts c ON c.jid = gs.group_id
      ORDER BY gs.listening DESC, c.name ASC
    `)
    _stmtGetDisabled = db.prepare('SELECT command FROM group_disabled_commands WHERE group_id = ?')
    _stmtUpsertGroup = db.prepare('INSERT OR IGNORE INTO group_settings (group_id, listening, troll_mode) VALUES (?, 0, 0)')
    _stmtUpdateListening = db.prepare('UPDATE group_settings SET listening = ? WHERE group_id = ?')
    _stmtUpdateTroll = db.prepare('UPDATE group_settings SET troll_mode = ? WHERE group_id = ?')
    _stmtInsertDisabled = db.prepare('INSERT OR IGNORE INTO group_disabled_commands (group_id, command) VALUES (?, ?)')
    _stmtDeleteDisabled = db.prepare('DELETE FROM group_disabled_commands WHERE group_id = ? AND command = ?')
    _stmtDeleteAllDisabled = db.prepare('DELETE FROM group_disabled_commands WHERE group_id = ?')
  }
  return {
    getGroups: _stmtGetGroups, getDisabled: _stmtGetDisabled,
    upsertGroup: _stmtUpsertGroup, updateListening: _stmtUpdateListening,
    updateTroll: _stmtUpdateTroll, insertDisabled: _stmtInsertDisabled,
    deleteDisabled: _stmtDeleteDisabled, deleteAllDisabled: _stmtDeleteAllDisabled,
  }
}

function getCommands() {
  try {
    return db.prepare('SELECT name, description FROM commands ORDER BY name').all()
  } catch (_) {
    return []
  }
}

app.get('/api/groups', (req, res) => {
  try {
    const s = settingsStmts()
    const groups = s.getGroups.all().filter(g => g.listening === 1).map(g => ({
      id: g.group_id,
      name: g.name || g.group_id.replace(/@g\.us$/, ''),
    }))
    res.json(groups)
  } catch (err) {
    log.error({ err }, 'Erro /api/groups')
    res.status(500).json({ error: err.message })
  }
})

// --- config API ---

const GLOBAL_ID = '__global__'

app.get('/api/config/groups', (req, res) => {
  try {
    const s = settingsStmts()
    const globalDisabled = s.getDisabled.all(GLOBAL_ID).map(r => r.command)
    const groups = s.getGroups.all().map(g => ({
      id: g.group_id,
      name: g.name || g.group_id.replace(/@g\.us$/, ''),
      listening: g.listening === 1,
      troll_mode: g.troll_mode === 1,
      disabled_commands: s.getDisabled.all(g.group_id).map(r => r.command),
    }))
    res.json({ groups, commands: getCommands(), global_disabled: globalDisabled })
  } catch (err) {
    log.error({ err }, 'Erro /api/config/groups')
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/config/groups/:id/listening', (req, res) => {
  try {
    const s = settingsStmts()
    const groupId = req.params.id
    const { enabled } = req.body
    s.upsertGroup.run(groupId)
    s.updateListening.run(enabled ? 1 : 0, groupId)
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT listening')
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/config/groups/:id/troll', (req, res) => {
  try {
    const s = settingsStmts()
    const groupId = req.params.id
    const { enabled } = req.body
    s.upsertGroup.run(groupId)
    s.updateTroll.run(enabled ? 1 : 0, groupId)
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT troll')
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/config/global/commands/:cmd', (req, res) => {
  try {
    const s = settingsStmts()
    const cmd = req.params.cmd
    const { disabled } = req.body

    // update global state
    if (disabled) {
      s.insertDisabled.run(GLOBAL_ID, cmd)
    } else {
      s.deleteDisabled.run(GLOBAL_ID, cmd)
    }

    // apply to all groups
    const groups = s.getGroups.all()
    for (const g of groups) {
      if (disabled) {
        s.insertDisabled.run(g.group_id, cmd)
      } else {
        s.deleteDisabled.run(g.group_id, cmd)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT global command')
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/config/groups/:id/commands/:cmd', (req, res) => {
  try {
    const s = settingsStmts()
    const { id: groupId, cmd } = req.params
    const { disabled } = req.body
    if (disabled) {
      s.insertDisabled.run(groupId, cmd)
    } else {
      s.deleteDisabled.run(groupId, cmd)
    }
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT command')
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/config/metrics', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    const row = db.prepare("SELECT value, updated_at FROM bot_metrics WHERE key = 'bot_metrics'").get()
    if (!row) return res.json(null)
    res.json({ ...JSON.parse(row.value), updated_at: row.updated_at })
  } catch (err) {
    log.error({ err }, 'Erro /api/config/metrics')
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/stats', (req, res) => {
  try {
    const { queryRange } = stmts()
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })

    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = queryRange.all(groupId, start, end)
      .map((r) => ({ name: getName(r.sender), sender: r.sender, count: r.count }))

    res.json({ name: getName(groupId), rows })
  } catch (err) {
    log.error({ err }, 'Erro /api/stats')
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/stats/daily', (req, res) => {
  try {
    const { queryDaily } = stmts()
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })

    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = queryDaily.all(groupId, start, end)
    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/daily')
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/stats/user-daily', (req, res) => {
  try {
    const { queryUserDaily } = stmts()
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })

    const sender = req.query.sender
    if (!sender) return res.status(400).json({ error: 'sender required' })

    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = queryUserDaily.all(groupId, sender, start, end)
    res.json(rows.map((r) => ({ ...r, name: getName(sender) })))
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/user-daily')
    res.status(500).json({ error: err.message })
  }
})

// top 5 users broken down by date (for charts)
app.get('/api/stats/top-users-daily', (req, res) => {
  try {
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })

    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    // get top 5 senders in the range
    const top5 = db.prepare(`
      SELECT sender, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY sender ORDER BY total DESC LIMIT 5
    `).all(groupId, start, end)

    // get daily breakdown for each
    const daily = db.prepare(`
      SELECT sender, date, day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND sender = ? AND date >= ? AND date <= ?
      GROUP BY date ORDER BY date
    `)

    const users = top5.map(u => ({
      sender: u.sender,
      name: getName(u.sender),
      total: u.total,
      days: daily.all(groupId, u.sender, start, end),
    }))

    res.json({ name: getName(groupId), users })
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/top-users-daily')
    res.status(500).json({ error: err.message })
  }
})

// aggregated by day of week
app.get('/api/stats/by-weekday', (req, res) => {
  try {
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = db.prepare(`
      SELECT day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY day_of_week ORDER BY day_of_week
    `).all(groupId, start, end)

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/by-weekday')
    res.status(500).json({ error: err.message })
  }
})

// period distribution (manha vs noite)
app.get('/api/stats/by-period', (req, res) => {
  try {
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = db.prepare(`
      SELECT period, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY period
    `).all(groupId, start, end)

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/by-period')
    res.status(500).json({ error: err.message })
  }
})

// top 5 users by day of week (radar)
app.get('/api/stats/users-weekday', (req, res) => {
  try {
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const top5 = db.prepare(`
      SELECT sender, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY sender ORDER BY total DESC LIMIT 5
    `).all(groupId, start, end)

    const byWeekday = db.prepare(`
      SELECT day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND sender = ? AND date >= ? AND date <= ?
      GROUP BY day_of_week ORDER BY day_of_week
    `)

    const users = top5.map(u => {
      const weekdays = Array(7).fill(0)
      byWeekday.all(groupId, u.sender, start, end).forEach(r => { weekdays[r.day_of_week] = r.total })
      return { sender: u.sender, name: getName(u.sender), weekdays }
    })

    res.json(users)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/users-weekday')
    res.status(500).json({ error: err.message })
  }
})

// daily total (group trend)
app.get('/api/stats/trend', (req, res) => {
  try {
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = db.prepare(`
      SELECT date, day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY date ORDER BY date
    `).all(groupId, start, end)

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/trend')
    res.status(500).json({ error: err.message })
  }
})

// period by day of week (manha vs noite per weekday)
app.get('/api/stats/period-weekday', (req, res) => {
  try {
    const groupId = req.query.group
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = db.prepare(`
      SELECT day_of_week, period, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY day_of_week, period ORDER BY day_of_week
    `).all(groupId, start, end)

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/period-weekday')
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  log.info(`Dashboard: http://localhost:${PORT}`)
})
