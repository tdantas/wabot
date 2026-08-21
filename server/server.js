require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })

const express = require('express')
const path = require('path')
const postgres = require('postgres')
const pino = require('pino')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
})

const sql = postgres(process.env.DATABASE_URL || 'postgres://wabot:wabot@localhost:5432/wabot', {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
})

const TZ = process.env.TZ || 'Europe/Lisbon'

const app = express()
app.set('etag', false)
const PORT = process.env.PORT || 3000
const ASSET_VERSION = require('crypto').createHash('md5')
  .update(require('fs').readdirSync(path.join(__dirname, 'public')).join(',') + Date.now())
  .digest('hex').slice(0, 8)

const staticOpts = {
  setHeaders(res, filePath) {
    if (filePath.match(/\.(css|js)$/)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable')
    }
  }
}

// Cache-busting: serve HTML with versioned CSS/JS references
const fs = require('fs')
function versionedStatic(dir, opts) {
  const staticMiddleware = express.static(dir, opts)
  return (req, res, next) => {
    const reqPath = req.path.endsWith('/') ? req.path + 'index.html' : req.path
    if (reqPath.endsWith('.html')) {
      const filePath = path.join(dir, reqPath)
      if (fs.existsSync(filePath)) {
        let html = fs.readFileSync(filePath, 'utf-8')
        html = html.replace(/(href|src)="([^"]+\.(css|js))"/g, `$1="$2?v=${ASSET_VERSION}"`)
        res.set('Cache-Control', 'no-cache')
        return res.type('html').send(html)
      }
    }
    staticMiddleware(req, res, next)
  }
}
const JWT_SECRET = process.env.JWT_SECRET || 'wabot-live-' + require('crypto').randomBytes(16).toString('hex')

app.use(cookieParser())

// --- clean URL routing: /prefix/group/UUID/page ---
const VALID_PAGES = ['group', 'calendar', 'charts', 'list', 'race', 'presence', 'settings']
const publicDir = path.join(__dirname, 'public')

function serveGroupPage(prefix) {
  return async (req, res) => {
    const page = req.params.page || 'group'
    if (!VALID_PAGES.includes(page)) return res.status(404).send('Not found')
    const filePath = path.join(publicDir, page + '.html')
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found')
    let html = fs.readFileSync(filePath, 'utf-8')
    // Prefix relative CSS/JS with absolute path + version hash (no <base> tag needed)
    const base = prefix ? prefix + '/' : '/'
    html = html.replace(/(href|src)="([^"/:][^"]*\.(css|js))"/g, `$1="${base}$2?v=${ASSET_VERSION}"`)

    // fuso do grupo: as datas dos filtros têm de ser calculadas nele, não no
    // relógio de quem abre a página
    let tz = DEFAULT_TZ
    try {
      const uuid = req.params.uuid
      const groupId = res.locals?.forceGroupId || (uuid ? await groupIdFromUuid(uuid) : null)
      if (groupId) tz = await groupTz(groupId)
    } catch (err) {
      log.error({ err }, 'Erro ao resolver fuso do grupo')
    }
    html = html.replace('</head>', `<script>window.GROUP_TZ=${JSON.stringify(tz)}</script></head>`)

    res.set('Cache-Control', 'no-cache')
    res.type('html').send(html)
  }
}

// Backward compatibility: redirect old ?id= URLs to clean paths
app.use((req, res, next) => {
  const id = req.query.id
  if (!id) return next()
  const match = req.path.match(/^(\/(?:admin|live))?\/(calendar|charts|list|race|presence|group|settings)\.html$/)
  if (match) {
    const pfx = match[1] || ''
    const page = match[2]
    const extra = new URLSearchParams(req.query)
    extra.delete('id')
    const qs = extra.toString()
    return res.redirect(301, `${pfx}/group/${encodeURIComponent(id)}/${page}${qs ? '?' + qs : ''}`)
  }
  next()
})

// Serve manifest.json and icons at all prefixes (needed for /live/ and /admin/ PWA)
for (const prefix of ['', '/live', '/admin']) {
  app.get(`${prefix}/manifest.json`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'))
  })
  app.get(`${prefix}/images/:file`, (req, res, next) => {
    const filePath = path.join(__dirname, 'public', 'images', req.params.file)
    res.sendFile(filePath, (err) => { if (err) next() })
  })
}

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    log.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start }, 'request')
  })
  next()
})

// --- helpers ---

async function groupIdFromUuid(uuid) {
  const [row] = await sql`SELECT group_id FROM group_settings WHERE uuid = ${uuid}`
  return row?.group_id || null
}

async function uuidFromGroupId(groupId) {
  const [row] = await sql`SELECT uuid FROM group_settings WHERE group_id = ${groupId}`
  return row?.uuid || null
}

async function getName(jid) {
  const [row] = await sql`SELECT name FROM contacts WHERE jid = ${jid}`
  return row?.name || jid.replace(/@(s\.whatsapp\.net|lid|g\.us)$/, '')
}

async function getNames(jids) {
  if (jids.length === 0) return new Map()
  const rows = await sql`SELECT jid, name FROM contacts WHERE jid = ANY(${jids})`
  const map = new Map(rows.map(r => [r.jid, r.name]))
  for (const jid of jids) {
    if (!map.has(jid)) map.set(jid, jid.replace(/@(s\.whatsapp\.net|lid|g\.us)$/, ''))
  }
  return map
}

const DEFAULT_TZ = TZ
const tzCache = new Map() // group_id → { tz, at }

// Fuso de apresentação do grupo (configurável na UI). Cache curta porque quem
// grava é este mesmo processo, mas o bot também lê a coluna.
async function groupTz(groupId) {
  const hit = tzCache.get(groupId)
  if (hit && Date.now() - hit.at < 60000) return hit.tz
  const [row] = await sql`SELECT timezone FROM group_settings WHERE group_id = ${groupId}`
  const tz = row?.timezone || DEFAULT_TZ
  tzCache.set(groupId, { tz, at: Date.now() })
  return tz
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

async function getRanking(groupId, start, end, limit = 10) {
  const TZ = await groupTz(groupId)
  const rows = await sql`
    SELECT sender, COUNT(*)::int as count FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ})
      AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
    GROUP BY sender ORDER BY count DESC
    LIMIT ${limit}
  `
  const nameMap = await getNames([groupId, ...rows.map(r => r.sender)])
  return {
    groupName: nameMap.get(groupId),
    rows: rows.map(r => ({
      sender: r.sender,
      name: nameMap.get(r.sender),
      count: r.count,
    })),
  }
}

async function getUuids(groupIds) {
  if (groupIds.length === 0) return new Map()
  const rows = await sql`SELECT group_id, uuid FROM group_settings WHERE group_id = ANY(${groupIds})`
  return new Map(rows.map(r => [r.group_id, r.uuid]))
}

async function resolveGroup(req, res) {
  if (res?.locals?.forceGroupId) return res.locals.forceGroupId
  const g = req.query.group
  if (g && g.includes('-') && !g.includes('@')) {
    return await groupIdFromUuid(g) || g
  }
  return g
}

// --- auth: token → JWT cookie ---
app.get('/auth/:token', async (req, res) => {
  try {
    const { token } = req.params
    const [row] = await sql`SELECT group_id, expires_at FROM live_tokens WHERE token = ${token}`

    if (!row) {
      return res.status(401).send(expiredPage('Este link já foi utilizado ou não existe. Peça um novo com <b> !live </b> no grupo.'))
    }

    if (new Date(row.expires_at) < new Date()) {
      await sql`DELETE FROM live_tokens WHERE token = ${token}`
      return res.status(401).send(expiredPage('Este link expirou. Peça um novo com !live no grupo.'))
    }

    // single use: delete token immediately
    await sql`DELETE FROM live_tokens WHERE token = ${token}`

    const payload = { groupId: row.group_id }
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1d' })

    res.cookie('wabot_live', jwtToken, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    })

    let groupUuid = await uuidFromGroupId(row.group_id)
    if (!groupUuid) {
      const newUuid = uuidv4()
      try {
        await sql`UPDATE group_settings SET uuid = ${newUuid} WHERE group_id = ${row.group_id}`
        groupUuid = newUuid
      } catch (e) {
        log.error({ err: e, groupId: row.group_id }, 'Failed to generate UUID on auth')
      }
    }
    res.redirect(`/live/group/${encodeURIComponent(groupUuid || row.group_id)}/calendar`)
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

// --- live middleware ---
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

function liveApiAuth(req, res, next) {
  const token = req.cookies?.wabot_live
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    res.locals.forceGroupId = payload.groupId
    next()
  } catch (err) {
    return res.status(401).json({ error: 'expired' })
  }
}

app.get('/live/group/:uuid', liveAuth, serveGroupPage('/live'))
app.get('/live/group/:uuid/:page', liveAuth, serveGroupPage('/live'))
app.use('/live', liveAuth, versionedStatic(path.join(__dirname, 'public'), staticOpts))

// --- group UUID: generate for groups that don't have one ---
;(async () => {
  try {
    const groups = await sql`SELECT group_id FROM group_settings WHERE uuid IS NULL`
    if (groups.length > 0) {
      for (const g of groups) {
        await sql`UPDATE group_settings SET uuid = ${uuidv4()} WHERE group_id = ${g.group_id}`
      }
      log.info({ count: groups.length }, 'Generated UUIDs for groups')
    }
  } catch (err) {
    log.warn({ err: err.message }, 'UUID generation failed')
  }
})()

// --- admin: seed on startup ---
;(async () => {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    try {
      const [exists] = await sql`SELECT id FROM admins WHERE email = ${process.env.ADMIN_EMAIL}`
      if (!exists) {
        const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10)
        await sql`INSERT INTO admins (email, password_hash) VALUES (${process.env.ADMIN_EMAIL}, ${hash})`
        log.info({ email: process.env.ADMIN_EMAIL }, 'Admin user created')
      }
    } catch (err) {
      log.error({ err }, 'Failed to seed admin')
    }
  }
})()

// --- admin login ---
app.get('/admin/login', (req, res) => {
  res.send(adminLoginPage())
})

app.post('/admin/login', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { email, password } = req.body
    const [admin] = await sql`SELECT id, email, password_hash FROM admins WHERE email = ${email}`

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

app.get('/admin/groups', adminAuth, (req, res) => {
  let html = fs.readFileSync(path.join(publicDir, 'groups.html'), 'utf-8')
  html = html.replace(/(href|src)="([^"/:][^"]*\.(css|js))"/g, `$1="/admin/$2?v=${ASSET_VERSION}"`)
  res.set('Cache-Control', 'no-cache')
  res.type('html').send(html)
})
app.get('/admin/settings', adminAuth, (req, res) => {
  let html = fs.readFileSync(path.join(publicDir, 'settings.html'), 'utf-8')
  html = html.replace(/(href|src)="([^"/:][^"]*\.(css|js))"/g, `$1="/admin/$2?v=${ASSET_VERSION}"`)
  res.set('Cache-Control', 'no-cache')
  res.type('html').send(html)
})
app.get('/admin/group/:uuid', adminAuth, serveGroupPage('/admin'))
app.get('/admin/group/:uuid/:page', adminAuth, serveGroupPage('/admin'))
app.use('/admin', adminAuth, (req, res, next) => {
  if (req.path === '/' || req.path === '') return res.redirect('/admin/groups')
  next()
}, versionedStatic(path.join(__dirname, 'public'), staticOpts))

function adminApiAuth(req, res, next) {
  const token = req.cookies?.wabot_admin
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try { jwt.verify(token, JWT_SECRET); next() } catch { return res.status(401).json({ error: 'expired' }) }
}

// admin groups API
app.get('/admin/api/groups', adminApiAuth, async (req, res) => {
  try {
    const groups = await sql`
      SELECT gs.group_id, gs.uuid, gs.listening, gs.troll_mode, c.name
      FROM group_settings gs
      LEFT JOIN contacts c ON c.jid = gs.group_id
      WHERE gs.listening = TRUE
      ORDER BY c.name ASC
    `
    const result = groups.map(g => ({
      id: g.uuid || g.group_id,
      name: g.name || g.group_id.replace(/@g\.us$/, ''),
    }))
    res.json(result)
  } catch (err) {
    log.error({ err }, 'Erro /admin/api/groups')
    res.status(500).json({ error: 'internal error' })
  }
})

// Public clean URLs (no auth)
app.get('/group/:uuid', serveGroupPage(''))
app.get('/group/:uuid/:page', serveGroupPage(''))

// --- protect direct access ---
const PROTECTED_PAGES = ['/list.html', '/charts.html', '/calendar.html', '/presence.html', '/settings.html', '/groups.html']
app.use((req, res, next) => {
  if (PROTECTED_PAGES.includes(req.path)) return res.redirect('/')
  next()
})

app.use(versionedStatic(path.join(__dirname, 'public'), staticOpts))
app.use(express.json())

// --- public groups API ---
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await sql`
      SELECT gs.group_id, gs.uuid, c.name
      FROM group_settings gs
      LEFT JOIN contacts c ON c.jid = gs.group_id
      WHERE gs.listening = TRUE
      ORDER BY c.name ASC
    `
    const result = groups.map(g => ({
      id: g.uuid || g.group_id,
      name: g.name || g.group_id.replace(/@g\.us$/, ''),
    }))
    res.json(result)
  } catch (err) {
    log.error({ err }, 'Erro /api/groups')
    res.status(500).json({ error: 'internal error' })
  }
})

// --- config API (admin only) ---
const GLOBAL_ID = '__global__'

app.get('/api/config/groups', adminApiAuth, async (req, res) => {
  try {
    const [globalDisabledRows, groups, allDisabled, allMeta, cmds] = await Promise.all([
      sql`SELECT command FROM group_disabled_commands WHERE group_id = ${GLOBAL_ID}`,
      sql`SELECT gs.group_id, gs.uuid, gs.listening, gs.troll_mode, gs.milestones, gs.timezone, c.name
          FROM group_settings gs LEFT JOIN contacts c ON c.jid = gs.group_id
          ORDER BY gs.listening DESC, c.name ASC`,
      sql`SELECT group_id, command FROM group_disabled_commands WHERE group_id != ${GLOBAL_ID}`,
      sql`SELECT group_id, transcript_daily_limit, transcript_max_seconds FROM group_metadata`,
      sql`SELECT name, description FROM commands ORDER BY name`,
    ])

    const globalDisabled = globalDisabledRows.map(r => r.command)
    const disabledMap = new Map()
    for (const r of allDisabled) {
      if (!disabledMap.has(r.group_id)) disabledMap.set(r.group_id, [])
      disabledMap.get(r.group_id).push(r.command)
    }
    const metaMap = new Map(allMeta.map(r => [r.group_id, r]))

    const result = groups.map(g => ({
      id: g.group_id,
      uuid: g.uuid || g.group_id,
      name: g.name || g.group_id.replace(/@g\.us$/, ''),
      listening: g.listening,
      troll_mode: g.troll_mode,
      milestones: g.milestones,
      timezone: g.timezone || DEFAULT_TZ,
      disabled_commands: disabledMap.get(g.group_id) || [],
      transcript_daily_limit: metaMap.get(g.group_id)?.transcript_daily_limit ?? 2,
      transcript_max_seconds: metaMap.get(g.group_id)?.transcript_max_seconds ?? 30,
    }))
    res.json({ groups: result, commands: cmds, global_disabled: globalDisabled })
  } catch (err) {
    log.error({ err }, 'Erro /api/config/groups')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/listening', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const { enabled } = req.body
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
    await sql`INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (${groupId}, FALSE, FALSE) ON CONFLICT DO NOTHING`
    await sql`UPDATE group_settings SET listening = ${!!enabled} WHERE group_id = ${groupId}`

    // sync per-group defaults from global
    if (enabled) {
      await sql`DELETE FROM group_disabled_commands WHERE group_id = ${groupId}`
      await sql`
        INSERT INTO group_disabled_commands (group_id, command)
        SELECT ${groupId}, command FROM group_disabled_commands WHERE group_id = ${GLOBAL_ID}
      `
      // copy global premium users as group defaults
      await sql`
        INSERT INTO premium_users (group_id, sender)
        SELECT ${groupId}, sender FROM global_premium_users
        ON CONFLICT DO NOTHING
      `
    }

    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT listening')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/troll', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const { enabled } = req.body
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
    await sql`INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (${groupId}, FALSE, FALSE) ON CONFLICT DO NOTHING`
    await sql`UPDATE group_settings SET troll_mode = ${!!enabled} WHERE group_id = ${groupId}`
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT troll')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/milestones', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const { enabled } = req.body
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
    await sql`INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (${groupId}, FALSE, FALSE) ON CONFLICT DO NOTHING`
    await sql`UPDATE group_settings SET milestones = ${!!enabled} WHERE group_id = ${groupId}`
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT milestones')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/timezone', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const { timezone } = req.body
    if (!isValidTimezone(timezone)) return res.status(400).json({ error: 'invalid timezone' })
    await sql`INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (${groupId}, FALSE, FALSE) ON CONFLICT DO NOTHING`
    await sql`UPDATE group_settings SET timezone = ${timezone} WHERE group_id = ${groupId}`
    tzCache.delete(groupId)
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT timezone')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/global/commands/:cmd', adminApiAuth, async (req, res) => {
  try {
    const cmd = req.params.cmd
    const { disabled } = req.body
    if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be boolean' })
    const [cmdExists] = await sql`SELECT 1 FROM commands WHERE name = ${cmd}`
    if (!cmdExists) return res.status(400).json({ error: 'command not found' })

    if (disabled) {
      await sql`INSERT INTO group_disabled_commands (group_id, command) VALUES (${GLOBAL_ID}, ${cmd}) ON CONFLICT DO NOTHING`
    } else {
      await sql`DELETE FROM group_disabled_commands WHERE group_id = ${GLOBAL_ID} AND command = ${cmd}`
    }

    const groups = await sql`SELECT group_id FROM group_settings`
    for (const g of groups) {
      if (disabled) {
        await sql`INSERT INTO group_disabled_commands (group_id, command) VALUES (${g.group_id}, ${cmd}) ON CONFLICT DO NOTHING`
      } else {
        await sql`DELETE FROM group_disabled_commands WHERE group_id = ${g.group_id} AND command = ${cmd}`
      }
    }

    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT global command')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/commands/:cmd', adminApiAuth, async (req, res) => {
  try {
    const { id: groupId, cmd } = req.params
    const { disabled } = req.body
    if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be boolean' })
    if (disabled) {
      await sql`INSERT INTO group_disabled_commands (group_id, command) VALUES (${groupId}, ${cmd}) ON CONFLICT DO NOTHING`
    } else {
      await sql`DELETE FROM group_disabled_commands WHERE group_id = ${groupId} AND command = ${cmd}`
    }
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT command')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/transcript-limit', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const limit = parseInt(req.body.limit)
    if (isNaN(limit) || limit < 0 || limit > 1000) return res.status(400).json({ error: 'limit must be 0-1000' })
    await sql`
      INSERT INTO group_metadata (group_id, transcript_daily_limit) VALUES (${groupId}, ${limit})
      ON CONFLICT (group_id) DO UPDATE SET transcript_daily_limit = EXCLUDED.transcript_daily_limit
    `
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT transcript-limit')
    res.status(500).json({ error: 'internal error' })
  }
})

app.put('/api/config/groups/:id/transcript-max-seconds', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const seconds = parseInt(req.body.seconds)
    if (isNaN(seconds) || seconds < 1 || seconds > 3600) return res.status(400).json({ error: 'seconds must be 1-3600' })
    await sql`
      INSERT INTO group_metadata (group_id, transcript_max_seconds) VALUES (${groupId}, ${seconds})
      ON CONFLICT (group_id) DO UPDATE SET transcript_max_seconds = EXCLUDED.transcript_max_seconds
    `
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro PUT transcript-max-seconds')
    res.status(500).json({ error: 'internal error' })
  }
})

app.get('/api/config/groups/:id/premium-users', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const rows = await sql`SELECT pu.sender, c.name FROM premium_users pu LEFT JOIN contacts c ON c.jid = pu.sender WHERE pu.group_id = ${groupId}`
    res.json(rows.map(r => ({ sender: r.sender, name: r.name || r.sender })))
  } catch (err) {
    log.error({ err }, 'Erro GET premium-users')
    res.status(500).json({ error: 'internal error' })
  }
})

app.get('/api/config/global/premium-users', adminApiAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT gu.sender, c.name FROM global_premium_users gu LEFT JOIN contacts c ON c.jid = gu.sender`
    res.json(rows.map(r => ({ sender: r.sender, name: r.name || r.sender })))
  } catch (err) {
    log.error({ err }, 'Erro GET global premium-users')
    res.status(500).json({ error: 'internal error' })
  }
})

app.post('/api/config/global/premium-users', adminApiAuth, async (req, res) => {
  try {
    const { sender } = req.body
    if (!sender || typeof sender !== 'string') return res.status(400).json({ error: 'sender required' })
    await sql`INSERT INTO global_premium_users (sender) VALUES (${sender}) ON CONFLICT DO NOTHING`
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro POST global premium-user')
    res.status(500).json({ error: 'internal error' })
  }
})

app.delete('/api/config/global/premium-users/:sender', adminApiAuth, async (req, res) => {
  try {
    await sql`DELETE FROM global_premium_users WHERE sender = ${decodeURIComponent(req.params.sender)}`
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro DELETE global premium-user')
    res.status(500).json({ error: 'internal error' })
  }
})

app.post('/api/config/groups/:id/premium-users', adminApiAuth, async (req, res) => {
  try {
    const groupId = req.params.id
    const { sender } = req.body
    if (!sender || typeof sender !== 'string') return res.status(400).json({ error: 'sender required' })
    await sql`INSERT INTO premium_users (group_id, sender) VALUES (${groupId}, ${sender}) ON CONFLICT DO NOTHING`
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro POST premium-user')
    res.status(500).json({ error: 'internal error' })
  }
})

app.delete('/api/config/groups/:id/premium-users/:sender', adminApiAuth, async (req, res) => {
  try {
    const { id: groupId, sender } = req.params
    await sql`DELETE FROM premium_users WHERE group_id = ${groupId} AND sender = ${decodeURIComponent(sender)}`
    res.json({ ok: true })
  } catch (err) {
    log.error({ err }, 'Erro DELETE premium-user')
    res.status(500).json({ error: 'internal error' })
  }
})

app.get('/api/config/contacts', adminApiAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT jid, name FROM contacts WHERE type = 'person' ORDER BY name ASC`
    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro GET contacts')
    res.status(500).json({ error: 'internal error' })
  }
})

app.get('/api/config/metrics', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    const [row] = await sql`SELECT value, updated_at FROM bot_metrics WHERE key = 'bot_metrics'`
    if (!row) return res.json(null)
    res.json({ ...JSON.parse(row.value), updated_at: row.updated_at })
  } catch (err) {
    log.error({ err }, 'Erro /api/config/metrics')
    res.status(500).json({ error: 'internal error' })
  }
})

// --- stats router (shared between /api, /live/api, /admin/api) ---
const statsRouter = express.Router()

statsRouter.get('/', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)

    const limite = Math.min(parseInt(req.query.limit) || 10, 200)
    const { groupName, rows } = await getRanking(groupId, req.query.start, req.query.end, limite)
    res.json({ name: groupName, rows })
  } catch (err) {
    log.error({ err }, 'Erro /api/stats')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/daily', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)

    const start = req.query.start || null
    const end = req.query.end || null

    const rows = await sql`
      SELECT (created_at AT TIME ZONE ${TZ})::date as date,
             EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week,
             CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
             COUNT(*)::int as total
      FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ})
        AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
      GROUP BY 1, 2, 3 ORDER BY date, period
    `

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/daily')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/user-daily', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)

    const sender = req.query.sender
    if (!sender) return res.status(400).json({ error: 'sender required' })

    const start = req.query.start || null
    const end = req.query.end || null

    const rows = await sql`
      SELECT (created_at AT TIME ZONE ${TZ})::date as date,
             EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week,
             CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
             COUNT(*)::int as total
      FROM events
      WHERE group_id = ${groupId} AND sender = ${sender}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ})
        AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
      GROUP BY 1, 2, 3 ORDER BY date, period
    `

    const name = await getName(sender)
    res.json(rows.map(r => ({ ...r, name })))
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/user-daily')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/top-users-daily', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)

    const start = req.query.start || null
    const end = req.query.end || null

    const top5 = await sql`
      SELECT sender, COUNT(*)::int as total FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ})
        AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
      GROUP BY sender ORDER BY total DESC LIMIT 5
    `

    const senderIds = top5.map(u => u.sender)
    const [nameMap, allDays] = await Promise.all([
      getNames([groupId, ...senderIds]),
      sql`SELECT (created_at AT TIME ZONE ${TZ})::date as date, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, sender, COUNT(*)::int as total
          FROM events
          WHERE group_id = ${groupId} AND sender = ANY(${senderIds})
            AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          GROUP BY 1, 2, 3 ORDER BY date`,
    ])

    const daysBySender = new Map()
    for (const r of allDays) {
      if (!daysBySender.has(r.sender)) daysBySender.set(r.sender, [])
      daysBySender.get(r.sender).push(r)
    }

    const users = top5.map(u => ({
      sender: u.sender,
      name: nameMap.get(u.sender),
      total: u.total,
      days: daysBySender.get(u.sender) || [],
    }))

    res.json({ name: nameMap.get(groupId), users })
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/top-users-daily')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/by-weekday', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      rows = await sql`
        SELECT EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          AND sender = ANY(${senders})
        GROUP BY day_of_week ORDER BY day_of_week
      `
    } else {
      rows = await sql`
        SELECT EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY day_of_week ORDER BY day_of_week
      `
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/by-weekday')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/by-period', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      rows = await sql`
        SELECT CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
               COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          AND sender = ANY(${senders})
        GROUP BY period
      `
    } else {
      rows = await sql`
        SELECT CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
               COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY period
      `
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/by-period')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/users-weekday', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null

    const top5 = await sql`
      SELECT sender, COUNT(*)::int as total FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
      GROUP BY sender ORDER BY total DESC LIMIT 5
    `

    const senderIds = top5.map(u => u.sender)
    const [nameMap, allWeekdays] = await Promise.all([
      getNames(senderIds),
      sql`SELECT sender, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
          WHERE group_id = ${groupId} AND sender = ANY(${senderIds})
            AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          GROUP BY sender, day_of_week ORDER BY day_of_week`,
    ])

    const users = top5.map(u => {
      const weekdays = Array(7).fill(0)
      allWeekdays.filter(r => r.sender === u.sender).forEach(r => { weekdays[r.day_of_week] = r.total })
      return { sender: u.sender, name: nameMap.get(u.sender), weekdays }
    })

    res.json(users)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/users-weekday')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/trend', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      rows = await sql`
        SELECT (created_at AT TIME ZONE ${TZ})::date as date, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          AND sender = ANY(${senders})
        GROUP BY 1, 2 ORDER BY date
      `
    } else {
      rows = await sql`
        SELECT (created_at AT TIME ZONE ${TZ})::date as date, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY 1, 2 ORDER BY date
      `
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/trend')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/period-weekday', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      rows = await sql`
        SELECT EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week,
               CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
               COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          AND sender = ANY(${senders})
        GROUP BY day_of_week, period ORDER BY day_of_week
      `
    } else {
      rows = await sql`
        SELECT EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week,
               CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
               COUNT(*)::int as total FROM events
        WHERE group_id = ${groupId}
          AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY day_of_week, period ORDER BY day_of_week
      `
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/period-weekday')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/daily-winners', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null

    const rows = await sql`
      SELECT (created_at AT TIME ZONE ${TZ})::date as date, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, sender, COUNT(*)::int as total
      FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
      GROUP BY 1, 2, 3 ORDER BY date, total DESC
    `

    const byDate = new Map()
    for (const r of rows) {
      const key = r.date.toISOString().slice(0, 10)
      if (!byDate.has(key)) {
        byDate.set(key, { date: key, day_of_week: r.day_of_week, sender: r.sender, total: r.total })
      }
    }

    const winnerSenders = [...new Set([...byDate.values()].map(w => w.sender))]
    const nameMap = await getNames(winnerSenders)
    const result = [...byDate.values()].map(w => ({ ...w, name: nameMap.get(w.sender) }))

    res.json(result)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/daily-winners')
    res.status(500).json({ error: 'internal error' })
  }
})

// Taxa de mensagens por hora (estilo Prometheus): buckets horários dentro do
// período, com as horas mortas preenchidas a zero para o gráfico não saltar
// buracos. O time_bucket corre em UTC e é convertido no fim para o fuso do
// grupo — materializar já convertido partiria se o fuso mudasse na UI.
statsRouter.get('/hourly', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const senders = req.query.senders ? req.query.senders.split(',') : null

    let rows
    if (senders) {
      rows = await sql`
        SELECT to_char(bucket AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') as hora, total
        FROM (
          SELECT time_bucket_gapfill('1 hour', created_at) as bucket,
                 COALESCE(COUNT(*), 0)::int as total
          FROM events
          WHERE group_id = ${groupId}
            AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ})
            AND created_at <  ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
            AND sender = ANY(${senders})
          GROUP BY time_bucket_gapfill('1 hour', created_at)
        ) t
        ORDER BY bucket
      `
    } else {
      rows = await sql`
        SELECT to_char(bucket AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') as hora, total
        FROM (
          SELECT time_bucket_gapfill('1 hour', created_at) as bucket,
                 COALESCE(COUNT(*), 0)::int as total
          FROM events
          WHERE group_id = ${groupId}
            AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ})
            AND created_at <  ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          GROUP BY time_bucket_gapfill('1 hour', created_at)
        ) t
        ORDER BY bucket
      `
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/hourly')
    res.status(500).json({ error: 'internal error' })
  }
})

// Presença por hora: quantas pessoas estiveram a acompanhar o grupo, a partir
// dos receipts de leitura já coalescidos em baldes de 5 minutos.
statsRouter.get('/presence', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const senders = req.query.senders ? req.query.senders.split(',') : null

    // date_trunc em vez de time_bucket: os baldes já vêm alinhados aos 5 min,
    // e `presence` não é hypertable
    let rows
    if (senders) {
      rows = await sql`
        SELECT to_char(date_trunc('hour', bucket) AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') as hora,
               COUNT(DISTINCT sender)::int as pessoas,
               (COUNT(*) * 5)::int as minutos
        FROM presence
        WHERE group_id = ${groupId}
          AND bucket >= (${start}::timestamp AT TIME ZONE ${TZ})
          AND bucket <  ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
          AND sender = ANY(${senders})
        GROUP BY date_trunc('hour', bucket) ORDER BY 1
      `
    } else {
      rows = await sql`
        SELECT to_char(date_trunc('hour', bucket) AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') as hora,
               COUNT(DISTINCT sender)::int as pessoas,
               (COUNT(*) * 5)::int as minutos
        FROM presence
        WHERE group_id = ${groupId}
          AND bucket >= (${start}::timestamp AT TIME ZONE ${TZ})
          AND bucket <  ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY date_trunc('hour', bucket) ORDER BY 1
      `
    }

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/presence')
    res.status(500).json({ error: 'internal error' })
  }
})

// Heatmap de presença de uma pessoa: células de 15 minutos, agregadas a partir
// dos baldes de 5 minutos guardados. `eventos` dá a intensidade da cor e
// `slots` (baldes de 5 min ocupados) dá o tempo presente dentro da célula.
statsRouter.get('/presence-heatmap', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    // sem `sender` devolve o agregado do grupo, com o número de pessoas
    // distintas presentes em cada célula
    const sender = req.query.sender || null
    const start = req.query.start || null
    const end = req.query.end || null

    const rows = sender
      ? await sql`
        SELECT to_char(bucket AT TIME ZONE ${TZ}, 'YYYY-MM-DD') as dia,
               (EXTRACT(HOUR FROM bucket AT TIME ZONE ${TZ}) * 4
                + FLOOR(EXTRACT(MINUTE FROM bucket AT TIME ZONE ${TZ}) / 15))::int as slot,
               SUM(events)::int as eventos,
               SUM(actions)::int as acoes,
               SUM(passive)::int as passivo,
               COUNT(*)::int as slots
        FROM presence
        WHERE group_id = ${groupId} AND sender = ${sender}
          AND bucket >= (${start}::timestamp AT TIME ZONE ${TZ})
          AND bucket <  ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY 1, 2
        ORDER BY 1, 2
      `
      : await sql`
        SELECT to_char(bucket AT TIME ZONE ${TZ}, 'YYYY-MM-DD') as dia,
               (EXTRACT(HOUR FROM bucket AT TIME ZONE ${TZ}) * 4
                + FLOOR(EXTRACT(MINUTE FROM bucket AT TIME ZONE ${TZ}) / 15))::int as slot,
               SUM(events)::int as eventos,
               COUNT(DISTINCT sender)::int as pessoas,
               COUNT(*)::int as slots
        FROM presence
        WHERE group_id = ${groupId}
          AND bucket >= (${start}::timestamp AT TIME ZONE ${TZ})
          AND bucket <  ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        GROUP BY 1, 2
        ORDER BY 1, 2
      `

    res.json(rows)
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/presence-heatmap')
    res.status(500).json({ error: 'internal error' })
  }
})

statsRouter.get('/race', async (req, res) => {
  try {
    const groupId = await resolveGroup(req, res)
    if (!groupId) return res.status(400).json({ error: 'group required' })
    const TZ = await groupTz(groupId)
    const start = req.query.start || null
    const end = req.query.end || null
    const limit = parseInt(req.query.limit) || 15

    // get top N senders in the full range
    const topSenders = await sql`
      SELECT sender, COUNT(*)::int as total FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
      GROUP BY sender ORDER BY total DESC LIMIT ${limit}
    `
    const senderIds = topSenders.map(s => s.sender)

    // get daily counts for those senders
    const rows = await sql`
      SELECT (created_at AT TIME ZONE ${TZ})::date as date, sender, COUNT(*)::int as total
      FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (${start}::timestamp AT TIME ZONE ${TZ}) AND created_at < ((${end}::date + 1)::timestamp AT TIME ZONE ${TZ})
        AND sender = ANY(${senderIds})
      GROUP BY 1, 2 ORDER BY date
    `

    const nameMap = await getNames([groupId, ...senderIds])

    res.json({ name: nameMap.get(groupId), senders: senderIds.map(s => ({ sender: s, name: nameMap.get(s) })), days: rows })
  } catch (err) {
    log.error({ err }, 'Erro /api/stats/race')
    res.status(500).json({ error: 'internal error' })
  }
})

// mount stats router on all paths
app.use('/api/stats', statsRouter)
app.use('/live/api/stats', liveApiAuth, statsRouter)
app.use('/admin/api/stats', adminApiAuth, statsRouter)

// --- widget API (API key auth) ---
const WIDGET_API_KEY = process.env.WIDGET_API_KEY
app.get('/api/widget', async (req, res) => {
  if (!WIDGET_API_KEY) return res.status(503).json({ error: 'widget not configured' })
  if (req.query.key !== WIDGET_API_KEY) return res.status(401).json({ error: 'invalid key' })

  try {
    const groupUuid = req.query.group
    if (!groupUuid) return res.status(400).json({ error: 'group required' })

    const groupId = await groupIdFromUuid(groupUuid)
    if (!groupId) return res.status(404).json({ error: 'group not found' })

    const today = new Date().toISOString().split('T')[0]
    const start = req.query.start || today
    const end = req.query.end || today

    const { groupName, rows } = await getRanking(groupId, start, end)
    res.json({
      name: groupName,
      period: { start, end },
      rows: rows.map(({ name, count }) => ({ name, count })),
    })
  } catch (err) {
    log.error({ err }, 'Erro /api/widget')
    res.status(500).json({ error: 'internal error' })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  log.info(`Dashboard: http://localhost:${PORT}`)
})
