const { open } = require('./db')

let db

function getDb() {
  if (!db) db = open()
  return db
}

// --- groups ---

function getGroups() {
  return getDb().prepare(`
    SELECT gs.group_id, gs.listening, gs.troll_mode, c.name
    FROM group_settings gs
    LEFT JOIN contacts c ON c.jid = gs.group_id
    ORDER BY gs.listening DESC, c.name ASC
  `).all()
}

function getListeningGroupIds() {
  return getDb().prepare(
    'SELECT group_id FROM group_settings WHERE listening = 1'
  ).all().map(r => r.group_id)
}

function upsertGroup(groupId, fields) {
  const current = getDb().prepare('SELECT * FROM group_settings WHERE group_id = ?').get(groupId)
  if (!current) {
    getDb().prepare(
      'INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (?, ?, ?)'
    ).run(groupId, fields.listening ? 1 : 0, fields.troll_mode ? 1 : 0)
  } else {
    if (fields.listening !== undefined) {
      getDb().prepare('UPDATE group_settings SET listening = ? WHERE group_id = ?').run(fields.listening ? 1 : 0, groupId)
    }
    if (fields.troll_mode !== undefined) {
      getDb().prepare('UPDATE group_settings SET troll_mode = ? WHERE group_id = ?').run(fields.troll_mode ? 1 : 0, groupId)
    }
  }
}

function ensureGroup(groupId) {
  const d = getDb()
  const existing = d.prepare('SELECT 1 FROM group_settings WHERE group_id = ?').get(groupId)
  if (existing) return

  d.transaction(() => {
    d.prepare('INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (?, 0, 0)').run(groupId)
    // disable all commands by default
    const cmds = d.prepare('SELECT name FROM commands').all()
    const insert = d.prepare('INSERT OR IGNORE INTO group_disabled_commands (group_id, command) VALUES (?, ?)')
    for (const cmd of cmds) {
      insert.run(groupId, cmd.name)
    }
  })()
}

// --- troll mode ---

function isTroll(groupId) {
  const row = getDb().prepare('SELECT troll_mode FROM group_settings WHERE group_id = ?').get(groupId)
  return row?.troll_mode === 1
}

// --- disabled commands ---

function getDisabledCommands(groupId) {
  return getDb().prepare(
    'SELECT command FROM group_disabled_commands WHERE group_id = ?'
  ).all(groupId).map(r => r.command)
}

function setCommandDisabled(groupId, command, disabled) {
  if (disabled) {
    getDb().prepare(
      'INSERT OR IGNORE INTO group_disabled_commands (group_id, command) VALUES (?, ?)'
    ).run(groupId, command)
  } else {
    getDb().prepare(
      'DELETE FROM group_disabled_commands WHERE group_id = ? AND command = ?'
    ).run(groupId, command)
  }
}

// --- seed from config.json (one-time migration) ---

function seedFromConfig(config) {
  const count = getDb().prepare('SELECT COUNT(*) as n FROM group_settings').get().n
  if (count > 0) return false

  const d = getDb()
  d.transaction(() => {
    for (const gid of (config.groups || [])) {
      d.prepare(
        'INSERT OR IGNORE INTO group_settings (group_id, listening, troll_mode) VALUES (?, 1, ?)'
      ).run(gid, (config.trollMode || []).includes(gid) ? 1 : 0)
    }

    // per-group disabled commands
    const groupDisabled = config.groupDisabledCommands || {}
    for (const [gid, cmds] of Object.entries(groupDisabled)) {
      for (const cmd of cmds) {
        d.prepare(
          'INSERT OR IGNORE INTO group_disabled_commands (group_id, command) VALUES (?, ?)'
        ).run(gid, cmd)
      }
    }

    // global disabled commands → apply to all groups
    const globalDisabled = config.disabledCommands || []
    if (globalDisabled.length > 0) {
      for (const gid of (config.groups || [])) {
        for (const cmd of globalDisabled) {
          d.prepare(
            'INSERT OR IGNORE INTO group_disabled_commands (group_id, command) VALUES (?, ?)'
          ).run(gid, cmd)
        }
      }
    }
  })()

  return true
}

function syncCommands(commandList) {
  const d = getDb()
  const upsert = d.prepare(
    'INSERT INTO commands (name, description) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description'
  )
  d.transaction(() => {
    for (const cmd of commandList) {
      upsert.run(cmd.name, cmd.description)
    }
  })()
}

module.exports = {
  getGroups,
  getListeningGroupIds,
  upsertGroup,
  ensureGroup,
  isTroll,
  getDisabledCommands,
  setCommandDisabled,
  seedFromConfig,
  syncCommands,
}
