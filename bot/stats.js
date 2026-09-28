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
// `mediaKind` distingue sticker de foto, áudio, vídeo e documento — o
// activity_type sozinho agrupa tudo em MEDIA_MESSAGE.
async function track(groupId, sender, activityType = ACTIVITY_TYPES.TEXT_MESSAGE, messageId = null, timestamp = null, mediaKind = null) {
  const createdAt = timestamp ? new Date(timestamp * 1000) : new Date()
  if (messageId) {
    await sql`
      INSERT INTO events (message_id, group_id, sender, activity_type, created_at, media_kind)
      SELECT ${messageId}, ${groupId}, ${sender}, ${activityType}, ${createdAt}, ${mediaKind}
      WHERE NOT EXISTS (
        SELECT 1 FROM events WHERE message_id = ${messageId}
      )
    `
  } else {
    await sql`
      INSERT INTO events (group_id, sender, activity_type, created_at, media_kind)
      VALUES (${groupId}, ${sender}, ${activityType}, ${createdAt}, ${mediaKind})
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

// Ranking com a repartição por horário: `diurnas` são as mensagens entre as
// 9h e as 18h no fuso do grupo. Uma query só, em vez de duas — o filtro
// agregado corre sobre as mesmas linhas.
const HORA_INICIO_DIURNO = 9
const HORA_FIM_DIURNO = 18

// O período pedido pelos comandos, aplicado a uma coluna de instante:
// `{ days }` conta dias de calendário incluindo hoje, `{ month: true }` o mês
// corrente e `{ year }` o ano inteiro — sempre no fuso do grupo.
function filtroPeriodo(TZ, opts, coluna) {
  const inicioDia = sql`date_trunc('day', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ}`
  if (opts.year) {
    return sql`
      ${coluna} >= (${opts.year + '-01-01'}::timestamp AT TIME ZONE ${TZ})
      AND ${coluna} < (${(opts.year + 1) + '-01-01'}::timestamp AT TIME ZONE ${TZ})
    `
  }
  if (opts.month) {
    return sql`${coluna} >= (date_trunc('month', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`
  }
  if (opts.days === 0) return sql`${coluna} >= (${inicioDia})`
  return sql`${coluna} >= (${inicioDia} - ${(opts.days - 1) + ' days'}::interval)`
}

async function getRankingDetalhado(groupId, opts = {}) {
  const TZ = await settings.getTimezone(groupId)
  const periodo = filtroPeriodo(TZ, opts, sql`created_at`)

  return sql`
    SELECT sender,
           COUNT(*)::int as total,
           COUNT(*) FILTER (
             WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ})
                   BETWEEN 9 AND 17
           )::int as diurnas
    FROM events
    WHERE group_id = ${groupId} AND ${periodo}
    GROUP BY sender ORDER BY total DESC
  `
}

// `days` dias fechados que acabam na meia-noite (do grupo) de `ateDia`, que
// fica de fora. É a janela do prémio semanal: apurado domingo de manhã, conta
// até sábado 23:59, sem as horas de domingo já passadas.
// (`::timestamp` e não `::date`: um date AT TIME ZONE é tratado como
// timestamptz na sessão e desloca o instante.)
async function getRankingAte(groupId, days, ateDia) {
  const TZ = await settings.getTimezone(groupId)
  const rows = await sql`
    SELECT sender, COUNT(*)::int as count FROM events
    WHERE group_id = ${groupId}
      AND created_at >= ((${ateDia}::date - ${days}::int)::timestamp AT TIME ZONE ${TZ})
      AND created_at <  (${ateDia}::date::timestamp AT TIME ZONE ${TZ})
    GROUP BY sender ORDER BY count DESC
  `
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

// Quem só acompanhou: baldes de presença de 5 min sem uma única ação
// (escrever, reagir, editar ou apagar). É o mesmo critério da tab "Só
// observam" da UI.
async function getObservadores(groupId, opts = {}) {
  const TZ = await settings.getTimezone(groupId)
  const periodo = filtroPeriodo(TZ, opts, sql`bucket`)

  return sql`
    SELECT sender, COUNT(*)::int as total
    FROM presence
    WHERE group_id = ${groupId}
      AND sender <> ${groupId}
      AND actions = 0
      AND ${periodo}
    GROUP BY sender ORDER BY total DESC
  `
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

// repartição por tipo do mês corrente, para uma pessoa
async function getMonthTypes(groupId, sender) {
  const TZ = await settings.getTimezone(groupId)
  return sql`
    SELECT CASE
             WHEN activity_type = 'REACTION' THEN 'reaction'
             WHEN activity_type = 'MEDIA_MESSAGE' THEN COALESCE(media_kind, 'media')
             ELSE 'text'
           END as tipo,
           COUNT(*)::int as total
    FROM events
    WHERE group_id = ${groupId} AND sender = ${sender}
      AND created_at >= (date_trunc('month', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})
    GROUP BY 1 ORDER BY 2 DESC
  `
}

async function getYear(groupId, year) {
  const TZ = await settings.getTimezone(groupId)
  const rows = await sql`
    SELECT sender, COUNT(*)::int as count FROM events
    WHERE group_id = ${groupId}
      AND created_at >= (${year + '-01-01'}::timestamp AT TIME ZONE ${TZ})
      AND created_at <  (${(year + 1) + '-01-01'}::timestamp AT TIME ZONE ${TZ})
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

module.exports = { ACTIVITY_TYPES, track, getRanking, getRankingAte, getRankingDetalhado, getObservadores, getToday, HORA_INICIO_DIURNO, HORA_FIM_DIURNO, getWeek, getMonth, getMonthTypes, getYear, getBusiestDay, getBusiestPeriod, getWeekDaily, getWeekUserDaily }
