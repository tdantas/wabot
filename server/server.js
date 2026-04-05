const express = require('express')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')
const pino = require('pino')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')

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
const staticOpts = {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache')
    }
  }
}
const JWT_SECRET = process.env.JWT_SECRET || 'wabot-live-' + require('crypto').randomBytes(16).toString('hex')

app.use(cookieParser())

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    log.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start }, 'request')
  })
  next()
})

// --- auth: token → JWT cookie ---
app.get('/auth/:token', (req, res) => {
  try {
    const { token } = req.params
    const row = db.prepare('SELECT group_id, expires_at FROM live_tokens WHERE token = ?').get(token)

    if (!row) {
      return res.status(401).send(expiredPage('Este link já foi utilizado ou não existe. Peça um novo com <b> !live </b> no grupo.'))
    }

    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM live_tokens WHERE token = ?').run(token)
      return res.status(401).send(expiredPage('Este link expirou. Peça um novo com !live no grupo.'))
    }

    // single use: delete token immediately
    db.prepare('DELETE FROM live_tokens WHERE token = ?').run(token)

    const payload = { groupId: row.group_id }
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1d' })

    res.cookie('wabot_live', jwtToken, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    })

    let groupUuid = uuidFromGroupId(row.group_id)
    if (!groupUuid) {
      // generate UUID on the fly if missing
      const newUuid = uuidv4()
      try {
        db.prepare('UPDATE group_settings SET uuid = ? WHERE group_id = ?').run(newUuid, row.group_id)
        groupUuid = newUuid
      } catch (e) {
        log.error({ err: e, groupId: row.group_id }, 'Failed to generate UUID on auth')
      }
    }
    res.redirect(`/live/group.html?id=${encodeURIComponent(groupUuid || row.group_id)}`)
  } catch (err) {
    log.error({ err }, 'Erro /auth/:token')
    res.status(500).send('Erro interno')
  }
})

function expiredPage(message) {
  return `<!DOCTYPE html>
<html lang="pt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WABot — Acesso</title>
<style>
  body{font-family:'Outfit',system-ui,sans-serif;background:#0a0b0f;color:#e8e6e1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{text-align:center;padding:48px;border-radius:16px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.06);max-width:400px}
  h1{font-size:1.4rem;margin-bottom:12px;color:#e8a832}
  p{color:#a09d95;font-size:0.9rem;line-height:1.5}
</style></head><body>
<div class="card"><h1>Acesso negado</h1><p>${message}</p></div>
</body></html>`
}

// --- live middleware: validates JWT, restricts to group ---
function liveAuth(req, res, next) {
  const token = req.cookies?.wabot_live
  if (!token) {
    return res.status(401).send(expiredPage('Sem acesso. Peça um link com !live no grupo.'))
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.liveGroupId = payload.groupId
    next()
  } catch (err) {
    res.clearCookie('wabot_live')
    return res.status(401).send(expiredPage('O teu acesso expirou. Peça um novo link com !live no grupo.'))
  }
}

// --- live API middleware: validates JWT and restricts group param ---
function liveApiAuth(req, res, next) {
  const token = req.cookies?.wabot_live
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    // store real group_id for resolveGroup to use
    res.locals.forceGroupId = payload.groupId
    next()
  } catch (err) {
    return res.status(401).json({ error: 'expired' })
  }
}

// --- serve live pages (protected, same files as public) ---
app.use('/live', liveAuth, express.static(path.join(__dirname, 'public'), staticOpts))

// --- group UUID: ensure column exists and generate for groups that don't have one ---
try {
  // ensure uuid column exists (in case bot migrations haven't run yet)
  const cols = db.prepare("PRAGMA table_info(group_settings)").all().map(c => c.name)
  if (!cols.includes('uuid')) {
    db.exec("ALTER TABLE group_settings ADD COLUMN uuid TEXT")
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_group_settings_uuid ON group_settings (uuid)")
    log.info('Created uuid column on group_settings')
  }

  const groups = db.prepare("SELECT group_id FROM group_settings WHERE uuid IS NULL").all()
  if (groups.length > 0) {
    const stmt = db.prepare("UPDATE group_settings SET uuid = ? WHERE group_id = ?")
    for (const g of groups) {
      stmt.run(uuidv4(), g.group_id)
    }
    log.info({ count: groups.length }, 'Generated UUIDs for groups')
  }
} catch (err) {
  log.warn({ err: err.message }, 'UUID generation failed')
}

function groupIdFromUuid(uuid) {
  try {
    const row = db.prepare('SELECT group_id FROM group_settings WHERE uuid = ?').get(uuid)
    return row?.group_id || null
  } catch { return null }
}

function uuidFromGroupId(groupId) {
  try {
    const row = db.prepare('SELECT uuid FROM group_settings WHERE group_id = ?').get(groupId)
    return row?.uuid || null
  } catch { return null }
}

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

// --- admin: seed on startup if env is set ---
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`)
    const exists = db.prepare('SELECT id FROM admins WHERE email = ?').get(process.env.ADMIN_EMAIL)
    if (!exists) {
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10)
      db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(process.env.ADMIN_EMAIL, hash)
      log.info({ email: process.env.ADMIN_EMAIL }, 'Admin user created')
    }
  } catch (err) {
    log.error({ err }, 'Failed to seed admin')
  }
}

// --- admin login page ---
app.get('/admin/login', (req, res) => {
  res.send(adminLoginPage())
})

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { email, password } = req.body
    const admin = db.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?').get(email)

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.send(adminLoginPage('Email ou password incorretos.'))
    }

    const token = jwt.sign({ admin: true, email: admin.email }, JWT_SECRET, { expiresIn: '7d' })
    res.cookie('wabot_admin', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' })
    res.redirect('/admin/')
  } catch (err) {
    log.error({ err }, 'Admin login error')
    res.send(adminLoginPage('Erro interno.'))
  }
})

app.get('/admin/logout', (req, res) => {
  res.clearCookie('wabot_admin')
  res.redirect('/')
})

function adminLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="pt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WABot — Admin Login</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Outfit',sans-serif;background:#0a0b0f;color:#e8e6e1;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{width:100%;max-width:380px;padding:40px 32px;border-radius:16px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.06)}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:28px;justify-content:center}
  .brand-mark{width:40px;height:40px;background:linear-gradient(135deg,#e8a832,#d4922a);border-radius:10px;display:grid;place-items:center;font-family:'Bricolage Grotesque',serif;font-weight:800;font-size:1rem;color:#0a0b0f}
  .brand h2{font-family:'Bricolage Grotesque',serif;font-weight:800;font-size:1.6rem;letter-spacing:-1px}
  .brand h2 span{color:#e8a832}
  .error{background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.2);color:#f87171;padding:10px 14px;border-radius:8px;font-size:.82rem;margin-bottom:16px}
  label{display:block;font-size:.75rem;color:#5a574f;text-transform:uppercase;letter-spacing:.5px;font-weight:500;margin-bottom:6px}
  input{width:100%;font-family:'Outfit',sans-serif;font-size:.88rem;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.04);color:#e8e6e1;outline:none;transition:border-color .2s;margin-bottom:16px}
  input:focus{border-color:rgba(232,168,50,0.3)}
  button{width:100%;font-family:'Outfit',sans-serif;font-size:.88rem;font-weight:600;padding:12px;border-radius:8px;border:none;background:#e8a832;color:#0a0b0f;cursor:pointer;transition:background .2s}
  button:hover{background:#d4922a}
</style></head><body>
<div class="card">
  <div class="brand"><div class="brand-mark">W</div><h2>WA<span>Bot</span></h2></div>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/admin/login">
    <label>Email</label>
    <input type="email" name="email" required autofocus>
    <label>Password</label>
    <input type="password" name="password" required>
    <button type="submit">Entrar</button>
  </form>
</div>
</body></html>`
}

// --- admin middleware ---
function adminAuth(req, res, next) {
  const token = req.cookies?.wabot_admin
  if (!token) return res.redirect('/admin/login')
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (!payload.admin) return res.redirect('/admin/login')
    req.adminEmail = payload.email
    next()
  } catch (err) {
    res.clearCookie('wabot_admin')
    return res.redirect('/admin/login')
  }
}

// --- admin pages (groups listing, full access) ---
app.use('/admin', adminAuth, (req, res, next) => {
  // serve same static files but admin has full access
  if (req.path === '/' || req.path === '') return res.redirect('/admin/groups.html')
  next()
}, express.static(path.join(__dirname, 'public'), staticOpts))

// --- admin API auth middleware ---
function adminApiAuth(req, res, next) {
  const token = req.cookies?.wabot_admin
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try { jwt.verify(token, JWT_SECRET); next() } catch { return res.status(401).json({ error: 'expired' }) }
}

// admin groups API
app.get('/admin/api/groups', adminApiAuth, (req, res) => {
  try {
    const s = settingsStmts()
    const groups = s.getGroups.all().filter(g => g.listening === 1).map(g => ({
      id: uuidFromGroupId(g.group_id) || g.group_id,
      name: g.name || g.group_id.replace(/@g\.us$/, ''),
    }))
    res.json(groups)
  } catch (err) {
    log.error({ err }, 'Erro /admin/api/groups')
    res.status(500).json({ error: err.message })
  }
})

// --- protect direct access to group/charts/calendar/settings pages ---
const PROTECTED_PAGES = ['/group.html', '/charts.html', '/calendar.html', '/settings.html', '/groups.html']
app.use((req, res, next) => {
  if (PROTECTED_PAGES.includes(req.path)) {
    return res.redirect('/')
  }
  next()
})

app.use(express.static(path.join(__dirname, 'public'), staticOpts))
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
      id: uuidFromGroupId(g.group_id) || g.group_id,
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

// --- stats router (shared between /api and /live/api) ---
const statsRouter = express.Router()

// resolve UUID → group_id (Express 5: req.query is a getter, can't mutate)
function resolveGroup(req, res) {
  // live mode: forced group from JWT
  if (res?.locals?.forceGroupId) return res.locals.forceGroupId
  const g = req.query.group
  if (g && g.includes('-') && !g.includes('@')) {
    return groupIdFromUuid(g) || g
  }
  return g
}

statsRouter.get('/', (req, res) => {
  try {
    const { queryRange } = stmts()
    const groupId = resolveGroup(req, res)
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

statsRouter.get('/daily', (req, res) => {
  try {
    const { queryDaily } = stmts()
    const groupId = resolveGroup(req, res)
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

statsRouter.get('/user-daily', (req, res) => {
  try {
    const { queryUserDaily } = stmts()
    const groupId = resolveGroup(req, res)
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
statsRouter.get('/top-users-daily', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
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
statsRouter.get('/by-weekday', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      const placeholders = senders.map(() => '?').join(',')
      rows = db.prepare(`
        SELECT day_of_week, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ? AND sender IN (${placeholders})
        GROUP BY day_of_week ORDER BY day_of_week
      `).all(groupId, start, end, ...senders)
    } else {
      rows = db.prepare(`
        SELECT day_of_week, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ?
        GROUP BY day_of_week ORDER BY day_of_week
      `).all(groupId, start, end)
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/by-weekday')
    res.status(500).json({ error: err.message })
  }
})

// period distribution (manha vs noite)
statsRouter.get('/by-period', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      const placeholders = senders.map(() => '?').join(',')
      rows = db.prepare(`
        SELECT period, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ? AND sender IN (${placeholders})
        GROUP BY period
      `).all(groupId, start, end, ...senders)
    } else {
      rows = db.prepare(`
        SELECT period, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ?
        GROUP BY period
      `).all(groupId, start, end)
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/by-period')
    res.status(500).json({ error: err.message })
  }
})

// top 5 users by day of week (radar)
statsRouter.get('/users-weekday', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
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
statsRouter.get('/trend', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      const placeholders = senders.map(() => '?').join(',')
      rows = db.prepare(`
        SELECT date, day_of_week, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ? AND sender IN (${placeholders})
        GROUP BY date ORDER BY date
      `).all(groupId, start, end, ...senders)
    } else {
      rows = db.prepare(`
        SELECT date, day_of_week, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ?
        GROUP BY date ORDER BY date
      `).all(groupId, start, end)
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/trend')
    res.status(500).json({ error: err.message })
  }
})

// period by day of week (manha vs noite per weekday)
statsRouter.get('/period-weekday', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      const placeholders = senders.map(() => '?').join(',')
      rows = db.prepare(`
        SELECT day_of_week, period, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ? AND sender IN (${placeholders})
        GROUP BY day_of_week, period ORDER BY day_of_week
      `).all(groupId, start, end, ...senders)
    } else {
      rows = db.prepare(`
        SELECT day_of_week, period, SUM(count) as total FROM daily_stats
        WHERE group_id = ? AND date >= ? AND date <= ?
        GROUP BY day_of_week, period ORDER BY day_of_week
      `).all(groupId, start, end)
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/period-weekday')
    res.status(500).json({ error: err.message })
  }
})

// top user per day (calendar view)
statsRouter.get('/daily-winners', (req, res) => {
  try {
    const groupId = resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const start = req.query.start || todayStr()
    const end = req.query.end || todayStr()

    const rows = db.prepare(`
      SELECT date, day_of_week, sender, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY date, sender ORDER BY date, total DESC
    `).all(groupId, start, end)

    // group by date, pick winner (highest total)
    const byDate = new Map()
    for (const r of rows) {
      if (!byDate.has(r.date)) {
        byDate.set(r.date, { date: r.date, day_of_week: r.day_of_week, sender: r.sender, name: getName(r.sender), total: r.total })
      }
    }

    res.json(Array.from(byDate.values()))
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/daily-winners')
    res.status(500).json({ error: err.message })
  }
})

// mount stats router on both paths
app.use('/api/stats', statsRouter)
app.use('/live/api/stats', liveApiAuth, statsRouter)
app.use('/admin/api/stats', adminApiAuth, statsRouter)

app.listen(PORT, '0.0.0.0', () => {
  log.info(`Dashboard: http://localhost:${PORT}`)
})
