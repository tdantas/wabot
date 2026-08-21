const { sql } = require('./db')
const settings = require('./settings')

// Cada consulta corre no fuso do grupo (configurável na UI): as funções abaixo
// resolvem-no num `TZ` local, que as queries interpolam.

const ACTIVITY_TYPES = {
  TEXT_MESSAGE: 'TEXT_MESSAGE',
  MEDIA_MESSAGE: 'MEDIA_MESSAGE',
  REACTION: 'REACTION',
  READ: 'READ',
}

// Insert individual event into hypertable (idempotent via message_id)
async function track(groupId, sender, activityType = ACTIVITY_TYPES.TEXT_MESSAGE, messageId = null, timestamp = null) {
  const createdAt = timestamp ? new Date(timestamp * 1000) : new Date()
  if (messageId) {
    await sql`
      INSERT INTO events (message_id, group_id, sender, activity_type, created_at)
      SELECT ${messageId}, ${groupId}, ${sender}, ${activityType}, ${createdAt}
      WHERE NOT EXISTS (
        SELECT 1 FROM events WHERE message_id = ${messageId}
      )
    `
  } else {
    await sql`
      INSERT INTO events (group_id, sender, activity_type, created_at)
      VALUES (${groupId}, ${sender}, ${activityType}, ${createdAt})
    `
  }
}

// --- query helpers (direct from events hypertable) ---

// `days` conta dias de calendário incluindo hoje, igual aos filtros da UI:
// 7 dias = da meia-noite de há 6 dias até agora.
async function getRanking(groupId, days) {
  const TZ = await settings.getTimezone(groupId)
  let rows
  if (days === 0) {
    rows = await sql`
      SELECT sender, COUNT(*)::int as count FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (date_trunc('day', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})
      GROUP BY sender ORDER BY count DESC
    `
  } else {
    rows = await sql`
      SELECT sender, COUNT(*)::int as count FROM events
      WHERE group_id = ${groupId}
        AND created_at >= (date_trunc('day', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} - ${(days - 1) + ' days'}::interval)
      GROUP BY sender ORDER BY count DESC
    `
  }
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

async function getToday(groupId) {
  return getRanking(groupId, 0)
}

async function getWeek(groupId) {
  const TZ = await settings.getTimezone(groupId)
  const rows = await sql`
    SELECT sender, COUNT(*)::int as count FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (date_trunc('week', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} - INTERVAL '1 day')
    GROUP BY sender ORDER BY count DESC
  `
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

async function getMonth(groupId) {
  const TZ = await settings.getTimezone(groupId)
  const rows = await sql`
    SELECT sender, COUNT(*)::int as count FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (date_trunc('month', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})
    GROUP BY sender ORDER BY count DESC
  `
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

async function getYear(groupId, year) {
  const TZ = await settings.getTimezone(groupId)
  const rows = await sql`
    SELECT sender, COUNT(*)::int as count FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (${year + '-01-01'}::date AT TIME ZONE ${TZ})
      AND created_at <  (${(year + 1) + '-01-01'}::date AT TIME ZONE ${TZ})
    GROUP BY sender ORDER BY count DESC
  `
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

async function getBusiestDay(groupId) {
  const TZ = await settings.getTimezone(groupId)
  return sql`
    SELECT EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (date_trunc('day', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} - INTERVAL '7 days')
    GROUP BY day_of_week ORDER BY total DESC
  `
}

async function getBusiestPeriod(groupId) {
  const TZ = await settings.getTimezone(groupId)
  return sql`
    SELECT CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ}) BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END as period,
           COUNT(*)::int as total FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (date_trunc('day', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} - INTERVAL '7 days')
    GROUP BY period ORDER BY total DESC
  `
}

async function getWeekDaily(groupId) {
  const TZ = await settings.getTimezone(groupId)
  return sql`
    SELECT (created_at AT TIME ZONE ${TZ})::date as date, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (date_trunc('week', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} - INTERVAL '1 day')
    GROUP BY 1, 2 ORDER BY date
  `
}

async function getWeekUserDaily(groupId, sender) {
  const TZ = await settings.getTimezone(groupId)
  return sql`
    SELECT (created_at AT TIME ZONE ${TZ})::date as date, EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::int as day_of_week, COUNT(*)::int as total FROM events
    WHERE group_id = ${groupId} AND sender = ${sender}
      AND created_at >= (date_trunc('week', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ} - INTERVAL '1 day')
    GROUP BY 1, 2 ORDER BY date
  `
}

module.exports = { ACTIVITY_TYPES, track, getRanking, getToday, getWeek, getMonth, getYear, getBusiestDay, getBusiestPeriod, getWeekDaily, getWeekUserDaily }
