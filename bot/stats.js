const { open } = require('./db')

const db = open()

const TZ = process.env.TZ || 'Europe/Lisbon'

function now() {
  const d = new Date()
  const str = d.toLocaleString('en-CA', { timeZone: TZ, hour12: false })
  const [datePart, timePart] = str.split(', ')
  const hour = parseInt(timePart.split(':')[0], 10)
  const day = new Date(datePart + 'T12:00:00').getDay()
  return { date: datePart, dayOfWeek: day, period: (hour >= 6 && hour < 18) ? 'manha' : 'noite' }
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

// lazy prepared statements — só inicializa após migrations
let _upsert, _queryRange, _queryBusiestDay, _queryBusiestPeriod, _queryWeekDaily, _queryWeekUserDaily

function stmts() {
  if (!_upsert) {
    _upsert = db.prepare(`
      INSERT INTO daily_stats (group_id, sender, date, day_of_week, period, count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (group_id, sender, date, period)
      DO UPDATE SET count = count + 1
    `)
    _queryRange = db.prepare(`
      SELECT sender, SUM(count) as count FROM daily_stats
      WHERE group_id = ? AND date >= ?
      GROUP BY sender ORDER BY count DESC
    `)
    _queryBusiestDay = db.prepare(`
      SELECT day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ?
      GROUP BY day_of_week ORDER BY total DESC
    `)
    _queryBusiestPeriod = db.prepare(`
      SELECT period, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ?
      GROUP BY period ORDER BY total DESC
    `)
    _queryWeekDaily = db.prepare(`
      SELECT date, day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND date >= ?
      GROUP BY date ORDER BY date
    `)
    _queryWeekUserDaily = db.prepare(`
      SELECT date, day_of_week, SUM(count) as total FROM daily_stats
      WHERE group_id = ? AND sender = ? AND date >= ?
      GROUP BY date ORDER BY date
    `)
  }
  return { upsert: _upsert, queryRange: _queryRange, queryBusiestDay: _queryBusiestDay, queryBusiestPeriod: _queryBusiestPeriod, queryWeekDaily: _queryWeekDaily, queryWeekUserDaily: _queryWeekUserDaily }
}

function track(groupId, sender) {
  const { date, dayOfWeek, period } = now()
  stmts().upsert.run(groupId, sender, date, dayOfWeek, period)
}

function getRanking(groupId, days) {
  const since = days === 0 ? now().date : daysAgo(days - 1)
  const rows = stmts().queryRange.all(groupId, since)
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

function getToday(groupId) {
  return getRanking(groupId, 0)
}

function getWeek(groupId) {
  const since = weekSunday()
  const rows = stmts().queryRange.all(groupId, since)
  const result = {}
  for (const row of rows) {
    result[row.sender] = row.count
  }
  return result
}

function getMonth(groupId) {
  return getRanking(groupId, 30)
}

function getBusiestDay(groupId) {
  return stmts().queryBusiestDay.all(groupId, daysAgo(6))
}

function getBusiestPeriod(groupId) {
  return stmts().queryBusiestPeriod.all(groupId, daysAgo(6))
}

function getWeekDaily(groupId) {
  return stmts().queryWeekDaily.all(groupId, weekSunday())
}

function getWeekUserDaily(groupId, sender) {
  return stmts().queryWeekUserDaily.all(groupId, sender, weekSunday())
}

module.exports = { track, getToday, getWeek, getMonth, getBusiestDay, getBusiestPeriod, getWeekDaily, getWeekUserDaily }
