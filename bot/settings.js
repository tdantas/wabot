const { sql } = require('./db')

// --- groups ---

async function getGroups() {
  return sql`
    SELECT gs.group_id, gs.listening, gs.troll_mode, c.name
    FROM group_settings gs
    LEFT JOIN contacts c ON c.jid = gs.group_id
    ORDER BY gs.listening DESC, c.name ASC
  `
}

async function getListeningGroupIds() {
  const rows = await sql`SELECT group_id FROM group_settings WHERE listening = TRUE`
  return rows.map(r => r.group_id)
}

async function upsertGroup(groupId, fields) {
  const [current] = await sql`SELECT * FROM group_settings WHERE group_id = ${groupId}`
  if (!current) {
    await sql`
      INSERT INTO group_settings (group_id, listening, troll_mode)
      VALUES (${groupId}, ${!!fields.listening}, ${!!fields.troll_mode})
    `
  } else {
    if (fields.listening !== undefined) {
      await sql`UPDATE group_settings SET listening = ${!!fields.listening} WHERE group_id = ${groupId}`
    }
    if (fields.troll_mode !== undefined) {
      await sql`UPDATE group_settings SET troll_mode = ${!!fields.troll_mode} WHERE group_id = ${groupId}`
    }
  }
}

async function ensureGroup(groupId) {
  const [existing] = await sql`SELECT 1 FROM group_settings WHERE group_id = ${groupId}`
  if (existing) return

  await sql.begin(async (tx) => {
    await tx`INSERT INTO group_settings (group_id, listening, troll_mode) VALUES (${groupId}, FALSE, FALSE)`
    const cmds = await tx`SELECT name FROM commands`
    for (const cmd of cmds) {
      await tx`INSERT INTO group_disabled_commands (group_id, command) VALUES (${groupId}, ${cmd.name}) ON CONFLICT DO NOTHING`
    }
  })
}

// --- troll mode ---

async function isTroll(groupId) {
  const [row] = await sql`SELECT troll_mode FROM group_settings WHERE group_id = ${groupId}`
  return row?.troll_mode === true
}

// --- disabled commands ---

async function getDisabledCommands(groupId) {
  const rows = await sql`SELECT command FROM group_disabled_commands WHERE group_id = ${groupId}`
  return rows.map(r => r.command)
}

async function setCommandDisabled(groupId, command, disabled) {
  if (disabled) {
    await sql`INSERT INTO group_disabled_commands (group_id, command) VALUES (${groupId}, ${command}) ON CONFLICT DO NOTHING`
  } else {
    await sql`DELETE FROM group_disabled_commands WHERE group_id = ${groupId} AND command = ${command}`
  }
}

// --- transcript limits ---

async function getTranscriptDailyLimit(groupId) {
  const [row] = await sql`SELECT transcript_daily_limit FROM group_metadata WHERE group_id = ${groupId}`
  return row?.transcript_daily_limit ?? 2
}

async function setTranscriptDailyLimit(groupId, limit) {
  await sql`
    INSERT INTO group_metadata (group_id, transcript_daily_limit) VALUES (${groupId}, ${limit})
    ON CONFLICT (group_id) DO UPDATE SET transcript_daily_limit = EXCLUDED.transcript_daily_limit
  `
}

async function getTranscriptMaxSeconds(groupId) {
  const [row] = await sql`SELECT transcript_max_seconds FROM group_metadata WHERE group_id = ${groupId}`
  return row?.transcript_max_seconds ?? 30
}

async function setTranscriptMaxSeconds(groupId, seconds) {
  await sql`
    INSERT INTO group_metadata (group_id, transcript_max_seconds) VALUES (${groupId}, ${seconds})
    ON CONFLICT (group_id) DO UPDATE SET transcript_max_seconds = EXCLUDED.transcript_max_seconds
  `
}

async function getTranscriptUsage(groupId, sender) {
  const [row] = await sql`
    SELECT count FROM transcript_usage
    WHERE group_id = ${groupId} AND sender = ${sender} AND used_at = CURRENT_DATE
  `
  return row?.count ?? 0
}

async function incrementTranscriptUsage(groupId, sender) {
  await sql`
    INSERT INTO transcript_usage (group_id, sender, used_at, count)
    VALUES (${groupId}, ${sender}, CURRENT_DATE, 1)
    ON CONFLICT (group_id, sender, used_at) DO UPDATE SET count = transcript_usage.count + 1
  `
}

// --- seed from config.json (one-time migration) ---

async function seedFromConfig(config) {
  const [{ n }] = await sql`SELECT COUNT(*)::int as n FROM group_settings`
  if (n > 0) return false

  await sql.begin(async (tx) => {
    for (const gid of (config.groups || [])) {
      await tx`
        INSERT INTO group_settings (group_id, listening, troll_mode)
        VALUES (${gid}, TRUE, ${(config.trollMode || []).includes(gid)})
        ON CONFLICT DO NOTHING
      `
    }

    const groupDisabled = config.groupDisabledCommands || {}
    for (const [gid, cmds] of Object.entries(groupDisabled)) {
      for (const cmd of cmds) {
        await tx`INSERT INTO group_disabled_commands (group_id, command) VALUES (${gid}, ${cmd}) ON CONFLICT DO NOTHING`
      }
    }

    const globalDisabled = config.disabledCommands || []
    if (globalDisabled.length > 0) {
      for (const gid of (config.groups || [])) {
        for (const cmd of globalDisabled) {
          await tx`INSERT INTO group_disabled_commands (group_id, command) VALUES (${gid}, ${cmd}) ON CONFLICT DO NOTHING`
        }
      }
    }
  })

  return true
}

// --- premium users ---

async function isPremium(groupId, sender) {
  const [global] = await sql`SELECT 1 FROM global_premium_users WHERE sender = ${sender}`
  if (global) return true
  const [group] = await sql`SELECT 1 FROM premium_users WHERE group_id = ${groupId} AND sender = ${sender}`
  return !!group
}

async function getPremiumUsers(groupId) {
  const globalRows = await sql`SELECT sender FROM global_premium_users`
  const groupRows = await sql`SELECT sender FROM premium_users WHERE group_id = ${groupId}`
  return { global: globalRows.map(r => r.sender), group: groupRows.map(r => r.sender) }
}

async function addPremiumUser(groupId, sender) {
  await sql`INSERT INTO premium_users (group_id, sender) VALUES (${groupId}, ${sender}) ON CONFLICT DO NOTHING`
}

async function removePremiumUser(groupId, sender) {
  await sql`DELETE FROM premium_users WHERE group_id = ${groupId} AND sender = ${sender}`
}

async function syncCommands(commandList) {
  await sql.begin(async (tx) => {
    for (const cmd of commandList) {
      await tx`
        INSERT INTO commands (name, description) VALUES (${cmd.name}, ${cmd.description})
        ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
      `
    }
  })
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
  getTranscriptDailyLimit,
  setTranscriptDailyLimit,
  getTranscriptMaxSeconds,
  setTranscriptMaxSeconds,
  getTranscriptUsage,
  incrementTranscriptUsage,
  isPremium,
  getPremiumUsers,
  addPremiumUser,
  removePremiumUser,
}
