const stats = require('./stats')
const contacts = require('./contacts')
const settings = require('./settings')
const log = require('./logger')
const { sql } = require('./db')

const POLL_MS = parseInt(process.env.MILESTONE_POLL_MS || '5000', 10)

// --- definições ---

// MILESTONES: contagem de mensagens no dia, do menor para o maior.
// Cada um é conquistado uma única vez na vida (por grupo).
const DAILY = [
  { type: 'DAILY_100', heading: 'MILESTONE', label: '100 MENSAGENS', threshold: 100 },
  { type: 'DAILY_150', heading: 'MILESTONE', label: '150 MENSAGENS', threshold: 150 },
  { type: 'DAILY_180', heading: 'MILESTONE', label: '180 MENSAGENS', threshold: 180 },
]

// PRÉMIOS: liderança simultânea de várias janelas de ranking, apurados ao
// domingo. Repetíveis — a mesma pessoa pode bisar ou fazer o poker em semanas
// diferentes. A ordem importa: só vale o mais difícil que a pessoa alcançar,
// para ninguém levar POKER e BISOU no mesmo domingo.
const WEEKLY = [
  { type: 'POKER', heading: 'PRÉMIO', label: 'POKER', feito: 'fez o *POKER*', windows: [7, 15, 21, 30] },
  { type: 'HAT_TRICK', heading: 'PRÉMIO', label: 'HAT TRICK', feito: 'fez o *HAT TRICK*', windows: [7, 15, 21] },
  { type: 'BISOU', heading: 'PRÉMIO', label: 'BISOU', feito: '*BISOU*', windows: [7, 15] },
]

const WEEKLY_DOW = 0 // domingo
const WEEKLY_HOUR = 0 // hora UTC — arranque do domingo

// --- estado em memória (a BD é que garante o não-repetir) ---

// `grupo:pessoa:tipo` já premiados. Não é limpo à meia-noite: um marco
// conquistado não volta a ser dado, então a marca vale para sempre.
const congratulated = new Set()
// grupos cujos marcos já foram lidos da BD nesta execução
const carregados = new Set()
// teto de mensagens por ciclo: ao ligar o toggle num grupo movimentado pode
// haver várias pessoas a qualificar de uma vez, e o WhatsApp não gosta de
// rajadas. O resto sai no ciclo seguinte, 5s depois.
const MAX_POR_CICLO = parseInt(process.env.MILESTONE_MAX_POR_CICLO || '2', 10)
let lastWeekly = null // data UTC da última verificação semanal

// --- helpers ---

// o dia corrente no fuso do grupo: é ele que define o que conta como "hoje"
// para os milestones de 100/150/180 mensagens
function today(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz })
}

// meia-noite de `day` no fuso do bot, como instante real (para o period_start).
// As duas formatações são lidas no mesmo fuso local, então a diferença entre
// elas é o desvio real de TZ face a UTC — mesmo que o container já corra em TZ.
function startOfDay(day, tz) {
  const utcMidnight = new Date(`${day}T00:00:00Z`)
  const emTZ = new Date(utcMidnight.toLocaleString('en-US', { timeZone: tz }))
  const emUTC = new Date(utcMidnight.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(utcMidnight.getTime() - (emTZ.getTime() - emUTC.getTime()))
}

function firstName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  const named = parts.find((p) => /[\p{L}\p{N}]/u.test(p))
  return named || parts[0] || 'meu mago'
}

// 7, 15 e 21 → "7, 15 e 21"
function listar(nums) {
  if (nums.length === 1) return String(nums[0])
  return `${nums.slice(0, -1).join(', ')} e ${nums[nums.length - 1]}`
}

// Uma linha de festejo, rotativa, para a mensagem não soar a recibo. O elogio
// é sempre à energia e ao que a pessoa traz ao grupo — nunca comparando com
// os outros, que era o que tornava isto provocador.
const FESTEJO_DIARIO = [
  'Que energia! O grupo fica mais vivo contigo por perto.',
  'Presença dessas é que segura a conversa de pé. Continua!',
  'Isso é papo bom o dia inteiro — o grupo agradece a animação.',
  'Comunicativo desse jeito é raro. Não baixa o ritmo!',
  'O grupo não seria o mesmo sem essa disposição toda.',
  'Puro gás! Continua a trazer assunto para a rapaziada.',
  'Que vontade de conversa! É disso que o grupo vive.',
  'Ninguém aqui fica calado contigo por perto. Arretado!',
]

const FESTEJO_SEMANAL = [
  'Consistência é isso — semana após semana, sempre presente.',
  'Liderar assim não é sorte, é dedicação ao grupo.',
  'Que semana! O grupo esteve nas tuas mãos.',
  'Presença constante, conversa boa. Merecido demais!',
]

let festejoIdx = 0

async function message(def, sender) {
  const nome = firstName(await contacts.getName(sender))
  const lista = def.windows ? FESTEJO_SEMANAL : FESTEJO_DIARIO
  const festejo = lista[festejoIdx++ % lista.length]
  const conquista = def.windows
    ? `Tu ${def.feito}: top 1 no rank de ${listar(def.windows)} dias!`
    : `Foram *${def.threshold} mensagens* só de hoje!`
  return [
    `🏆 *${def.heading} ${def.label}* 🏆`,
    '',
    `Parabéns, *${nome}*! ${conquista}`,
    festejo,
    '',
    '🤖 _mensagem automática do bot_',
  ].join('\n')
}

// líder isolado de um ranking; null se estiver vazio ou houver empate no topo
function leader(data) {
  const sorted = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return null
  if (sorted.length > 1 && sorted[1][1] === sorted[0][1]) return null
  return sorted[0][0]
}

// REGRA: um MILESTONE (100/150/180 mensagens) é conquistado uma única vez por
// pessoa em cada grupo, para sempre. Os já conquistados são lidos da BD na
// primeira passagem por cada grupo e ficam em memória a partir daí — o índice
// único `idx_milestone_awards_daily_once` é a rede de segurança para corridas
// entre duas instâncias, não a única guarda.
// (Os PRÉMIOS semanais não entram aqui: esses repetem-se de domingo a domingo.)
async function loadEarnedMilestones(groupId) {
  const rows = await sql`
    SELECT type, sender FROM milestone_awards
    WHERE group_id = ${groupId} AND category = 'DAILY'
  `
  for (const r of rows) congratulated.add(`${groupId}:${r.sender}:${r.type}`)
  log.info({ channel: groupId, count: rows.length }, 'milestones já conquistados carregados')
}

// Regista o prémio. Devolve false quando já existia — são os índices únicos
// que garantem isso, e é o que impede um restart (ou duas instâncias no ar)
// de repetir o parabéns.
async function registerAward({ type, category, groupId, sender, runDay, periodStart, periodEnd, params }) {
  const rows = await sql`
    INSERT INTO milestone_awards
      (type, category, group_id, sender, run_day, period_start, period_end, params)
    VALUES
      (${type}, ${category}, ${groupId}, ${sender}, ${runDay}::date, ${periodStart}, ${periodEnd}, ${params})
    ON CONFLICT DO NOTHING
    RETURNING award_id
  `
  return rows.length > 0
}

// --- marcos diários ---

// Relê as contagens de hoje de cada grupo monitorado e parabeniza quem cruzou
// algum marco desde o ciclo anterior. `send(groupId, text)` faz o envio.
async function poll(send) {
  let enviadas = 0

  for (const groupId of await settings.getMilestoneGroupIds()) {
    // cada grupo tem o seu fuso, logo a sua meia-noite
    const day = today(await settings.getTimezone(groupId))
    // primeira passagem por este grupo nesta execução: traz da BD quem já
    // conquistou o quê, para não tentar gravar o que já existe
    if (!carregados.has(groupId)) {
      await loadEarnedMilestones(groupId)
      carregados.add(groupId)
    }

    const counts = await stats.getToday(groupId)

    for (const [sender, count] of Object.entries(counts)) {
      for (const def of DAILY) {
        if (count < def.threshold) continue
        // milestone é uma vez na vida: se já foi conquistado, não há mensagem
        const key = `${groupId}:${sender}:${def.type}`
        if (congratulated.has(key)) continue
        if (enviadas >= MAX_POR_CICLO) continue // sai no próximo ciclo
        congratulated.add(key)

        // a gravação é o cadeado: se a pessoa já conquistou este marco alguma
        // vez, o índice único rejeita e não há mensagem
        let novo
        try {
          novo = await registerAward({
            type: def.type,
            category: 'DAILY',
            groupId,
            sender,
            runDay: day,
            periodStart: startOfDay(day, await settings.getTimezone(groupId)),
            periodEnd: new Date(),
            params: [def.threshold],
          })
        } catch (err) {
          // solta a marca em memória para tentar de novo no próximo ciclo
          congratulated.delete(key)
          throw err
        }
        if (!novo) {
          log.info({ channel: groupId, sender, tipo: def.type, runDay: day }, 'marco diário já conquistado antes')
          continue
        }

        log.info({ channel: groupId, sender, count, tipo: def.type }, `marco de ${def.threshold} mensagens no dia`)
        await send(groupId, await message(def, sender))
        enviadas++
      }
    }
  }
}

// --- marcos semanais ---

// Domingo às WEEKLY_HOUR UTC: quem liderar todas as janelas de um marco leva
// o parabéns. Só o marco mais difícil conta, e roda uma vez por domingo.
async function weekly(send, now = new Date()) {
  const runDay = now.toISOString().slice(0, 10)
  if (now.getUTCDay() !== WEEKLY_DOW) return
  if (now.getUTCHours() < WEEKLY_HOUR) return
  if (lastWeekly === runDay) return
  lastWeekly = runDay

  // todas as janelas usadas por qualquer marco, sem repetir queries
  const allWindows = [...new Set(WEEKLY.flatMap((d) => d.windows))]

  try {
    for (const groupId of await settings.getMilestoneGroupIds()) {
      const rankings = new Map()
      await Promise.all(allWindows.map(async (d) => {
        rankings.set(d, leader(await stats.getRanking(groupId, d)))
      }))

      // do mais difícil para o mais fácil: o primeiro que bater é o que vale
      const def = WEEKLY.find((d) => {
        const first = rankings.get(d.windows[0])
        return first && d.windows.every((w) => rankings.get(w) === first)
      })
      if (!def) continue

      const sender = rankings.get(def.windows[0])

      const maxWindow = Math.max(...def.windows)
      const periodStart = new Date(now.getTime() - maxWindow * 24 * 60 * 60 * 1000)

      const novo = await registerAward({
        type: def.type,
        category: 'WEEKLY',
        groupId,
        sender,
        runDay,
        periodStart,
        periodEnd: now,
        params: def.windows,
      })
      if (!novo) {
        log.info({ channel: groupId, sender, tipo: def.type, runDay }, 'marco semanal já premiado')
        continue
      }

      log.info({ channel: groupId, sender, tipo: def.type, janelas: def.windows }, 'marco semanal')
      await send(groupId, await message(def, sender))
    }
  } catch (err) {
    // deixa a verificação repetir no próximo ciclo em vez de perder o domingo
    lastWeekly = null
    throw err
  }
}

// --- agendamento ---

let timer = null
let running = false

// Arranca o polling. Chamável mais de uma vez (reconexão) sem duplicar o timer.
function start(send) {
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    poll(send)
      .then(() => weekly(send))
      .catch((err) => log.error({ err }, 'Erro ao verificar marcos'))
      .finally(() => { running = false })
  }, POLL_MS)
  timer.unref()
  log.info({
    diarios: DAILY.map((d) => d.threshold),
    semanais: WEEKLY.map((d) => `${d.type} (${d.windows.join('/')})`),
    intervalo: POLL_MS,
  }, 'Monitor de marcos iniciado')
}

module.exports = { start, poll, weekly, DAILY, WEEKLY }
