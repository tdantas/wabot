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
// `pontos` é o peso no !rank premios: uma janela liderada, um ponto.
const WEEKLY = [
  { type: 'POKER', heading: 'PRÊMIO', label: 'POKER', feito: 'fez o *POKER*', windows: [7, 15, 21, 30], pontos: 4 },
  { type: 'HAT_TRICK', heading: 'PRÊMIO', label: 'HAT TRICK', feito: 'fez o *HAT TRICK*', windows: [7, 15, 21], pontos: 3 },
  { type: 'BISOU', heading: 'PRÊMIO', label: 'BISOU', feito: '*BISOU*', windows: [7, 15], pontos: 2 },
]

// PRÉMIO SEMANAL: domingo às 11h00 no fuso do grupo, sobre a semana fechada
// (as janelas acabam no sábado 23:59, também no fuso do grupo).
const WEEKLY_DOW = 0 // domingo
const WEEKLY_MIN = 11 * 60 // 11h00

// PRÉMIO MENSAL: quem mais falou no mês, apurado no último dia às 11h15 locais.
// Ao contrário do semanal, este segue o fuso do grupo — o mês de um grupo em
// Recife não acaba à mesma hora que o de um grupo em Lisboa.
const MENSAL = {
  type: 'CAMPEAO_MES',
  heading: 'PRÊMIO',
  label: 'CAMPEÃO DO MÊS',
}

// PRÉMIO ANUAL: quem ganhou mais meses ao longo do ano, apurado a 31/12.
const ANUAL = {
  type: 'CAMPEAO_ANO',
  heading: 'PRÊMIO',
  label: 'CAMPEÃO DO ANO',
}

// rótulo curto de cada tipo, para o resumo do prémio mensal
const TIPO_LABEL = {
  text: ['💬', 'texto'],
  sticker: ['🩹', 'figurinhas'],
  image: ['🖼️', 'fotos'],
  video: ['🎬', 'vídeos'],
  audio: ['🎙️', 'áudios'],
  document: ['📄', 'documentos'],
  media: ['📎', 'média'],
  reaction: ['❤️', 'reações'],
}

// hora do grupo a partir da qual se apura (11h15)
const APURACAO_H = 11
const APURACAO_M = 15
const APURACAO_MIN = APURACAO_H * 60 + APURACAO_M

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
// `grupo:domingo` já apurados nesta execução, para não repetir queries a cada
// 5s — depois de um restart quem trava a repetição é o índice único da BD
const semanaisApurados = new Set()

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
  return named || parts[0] || 'amigo'
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
  'Presença dessas é que segura a prosa de pé. Continua!',
  'Isso é papo bom o dia inteiro — o grupo agradece a animação.',
  'Comunicativo desse jeito é raro. Não baixa o ritmo!',
  'O grupo não seria o mesmo sem essa disposição toda.',
  'Puro gás! Continua a trazer assunto para a rapaziada.',
  'Que vontade de conversa! É disso que o grupo vive.',
  'Ninguém aqui fica calado contigo por perto. Arretado!',
]

// Prémio semanal: agradecimento por usar a conversa para juntar os amigos.
// Tom sempre sincero e motivador — sem piada, sem ironia, sem comparar com
// ninguém.
const FESTEJO_SEMANAL = [
  'Amizade se cultiva conversando, e tu cuidou disso a semana inteira. Muito obrigado!',
  'Tua presença constante lembra a todos que aqui tem gente que se importa. Continua firme!',
  'Semana após semana, tu mostra que estar presente é um gesto de carinho com os amigos. Valeu!',
  'Grupo unido é grupo que conversa, e tu ajudou a manter esse laço forte. Que venham muitas semanas assim!',
  'Uma conversa de cada vez, tu ajudou a fazer desse grupo um lugar de encontro. Muito obrigado!',
  'Cada conversa que tu puxou essa semana deixou o grupo mais próximo. Obrigado por isso!',
  'Estar presente é o que mantém uma amizade viva, e tu esteve presente a semana toda. Continua assim!',
  'Tu fez do grupo um lugar onde dá gosto voltar. Muito obrigado pela dedicação!',
  'Uma boa conversa aproxima quem está longe, e tu aproximou muita gente essa semana. Valeu!',
  'Obrigado por dar tempo e atenção aos amigos. É isso que fortalece o grupo semana após semana.',
  'Tua participação mostra que amizade se faz com presença. Que essa energia continue!',
  'Foi mais uma semana em que tu ajudou a manter todo mundo junto. Obrigado, e segue firme!',
]

// Prémio mensal: 20 variações, sobre o valor de comunicar, agregar, ajudar e
// estar presente — não sobre o volume em si.
const FESTEJO_MENSAL = [
  'Conversar é o que transforma uma lista de contato em grupo de amigo de verdade. Valeu!',
  'Quem fala, aproxima. Esse mês foi tu que puxou a prosa — e isso vale muito, visse?',
  'Grupo vivo não nasce sozinho não: nasce porque tem gente que aparece todo dia.',
  'Tá presente é um jeito de cuidar. Esse mês tu cuidou bem dessa rapaziada.',
  'A conversa que tu começa hoje é a lembrança que alguém guarda amanhã.',
  'Agregar é dom. Tu tem, e o grupo todinho sente.',
  'Nem sempre é sobre o que se diz — é sobre tá ali quando alguém precisa de resposta.',
  'Um grupo vive das conversas que tem, e esse mês tu deu muita vida a ele.',
  'Puxar assunto é um jeito de dizer "tô aqui com vocês". Obrigado por dizer isso o mês inteiro!',
  'É a tua presença que faz o povo voltar aqui. Continua assim!',
  'Comunicação é ponte, visse? Esse mês tu construiu foi muita.',
  'Fazer o grupo rir, pensar ou responder — tudo isso conta, e tu fez os três.',
  'Energia de grupo é contagiante, e a desse mês começou foi em ti.',
  'Quem aparece todo dia acaba segurando todo mundo junto. Foi o teu caso, e o grupo agradece.',
  'Ninguém constrói amizade de longe sem conversar. Valeu por encurtar essa distância!',
  'Um mês inteirinho segurando a prosa de pé. O grupo agradece de coração.',
  'Tá presente é escolha de todo dia, e tu escolheu todos os dias desse mês.',
  'Prosa boa é o que segura amizade por anos. Tu fez a tua.',
  'O silêncio afasta, a palavra aproxima. Esse mês foi tu que aproximou a gente.',
  'Não é só o número não: é a vontade de tá junto que ele representa. Parabéns de coração!',
]

const FESTEJO_ANUAL = [
  'Um ano inteirinho segurando a prosa desse grupo. Isso é dedicação de quem se importa mesmo.',
  'Doze meses, e a tua presença foi a constante. O grupo não seria o mesmo sem tu, visse?',
  'O ano não se ganha falando mais: se ganha aparecendo sempre. E tu apareceu sempre.',
  'A amizade desse grupo passou por ti o ano todinho. Obrigado de coração!',
]

let festejoIdx = 0

function montarMensagem(def, nome, conquista, lista, extra = null) {
  const festejo = lista[festejoIdx++ % lista.length]
  return [
    `🏆 *${def.heading} ${def.label}* 🏆`,
    '',
    `Parabéns, *${nome}*! ${conquista}`,
    ...(extra ? [extra] : []),
    festejo,
    '',
    '🤖 _mensagem automática do bot_',
  ].join('\n')
}

// "💬 820 texto · 🖼️ 210 fotos · ❤️ 110 reações"
function resumoTipos(rows) {
  const partes = (rows || [])
    .filter((r) => r.total > 0)
    .map((r) => {
      const [icone, rotulo] = TIPO_LABEL[r.tipo] || ['•', r.tipo]
      return `${icone} ${r.total} ${rotulo}`
    })
  return partes.length ? `_${partes.join(' · ')}_` : null
}

async function message(def, sender) {
  const nome = firstName(await contacts.getName(sender))
  const conquista = def.windows
    ? `Tu ${def.feito}: foi quem mais puxou a conversa nos rankings de ${listar(def.windows)} dias!`
    : `Foram *${def.threshold} mensagens* só de hoje!`
  return montarMensagem(def, nome, conquista, def.windows ? FESTEJO_SEMANAL : FESTEJO_DIARIO)
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

    const counts = await settings.filterOmitted(groupId, await stats.getToday(groupId))

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

// Quem ganhou a semana fechada em `data` (um domingo, no fuso do grupo): as
// janelas acabam no fim de sábado, e vale o prémio mais difícil que a mesma
// pessoa liderar. Devolve null quando ninguém lidera tudo ou há empate.
// É usada pelo apuramento ao domingo e pelo backfill-awards.js.
async function apurarSemana(groupId, data) {
  // todas as janelas usadas por qualquer prémio, sem repetir queries
  const allWindows = [...new Set(WEEKLY.flatMap((d) => d.windows))]
  const rankings = new Map()
  await Promise.all(allWindows.map(async (d) => {
    rankings.set(d, leader(await settings.filterOmitted(groupId, await stats.getRankingAte(groupId, d, data))))
  }))

  // do mais difícil para o mais fácil: o primeiro que bater é o que vale
  const def = WEEKLY.find((d) => {
    const first = rankings.get(d.windows[0])
    return first && d.windows.every((w) => rankings.get(w) === first)
  })
  if (!def) return null
  return { def, sender: rankings.get(def.windows[0]) }
}

// Grava o prémio da semana de `data`. false = já existia.
async function gravarSemana(groupId, def, sender, data, tz) {
  const [ano, mes, dia] = data.split('-').map(Number)
  const maxWindow = Math.max(...def.windows)
  const inicio = new Date(Date.UTC(ano, mes - 1, dia - maxWindow)).toISOString().slice(0, 10)
  return registerAward({
    type: def.type,
    category: 'WEEKLY',
    groupId,
    sender,
    runDay: data,
    periodStart: startOfDay(inicio, tz),
    periodEnd: startOfDay(data, tz),
    params: def.windows,
  })
}

// Domingo às 11h do grupo: quem liderar todas as janelas de um prémio leva o
// parabéns. Só o mais difícil conta, e cada grupo é apurado uma vez por domingo.
async function weekly(send, now = new Date()) {
  for (const groupId of await settings.getMilestoneGroupIds()) {
    const tz = await settings.getTimezone(groupId)
    const { ano, mes, dia, minutos, data } = partesLocais(tz, now)

    if (new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay() !== WEEKLY_DOW) continue
    if (minutos < WEEKLY_MIN) continue

    const chave = `${groupId}:${data}`
    if (semanaisApurados.has(chave)) continue
    semanaisApurados.add(chave)

    try {
      // janelas fechadas no fim de sábado: `data` é o domingo, que fica de fora
      const vencedor = await apurarSemana(groupId, data)
      if (!vencedor) continue
      const { def, sender } = vencedor

      const novo = await gravarSemana(groupId, def, sender, data, tz)
      if (!novo) {
        log.info({ channel: groupId, sender, tipo: def.type, runDay: data }, 'prémio semanal já entregue')
        continue
      }

      log.info({ channel: groupId, sender, tipo: def.type, janelas: def.windows }, 'prémio semanal')
      await send(groupId, await message(def, sender))
    } catch (err) {
      // deixa a verificação repetir no próximo ciclo em vez de perder o domingo
      semanaisApurados.delete(chave)
      throw err
    }
  }
}

// --- prémio mensal e anual ---

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

// data e hora no fuso do grupo, decompostas
function partesLocais(tz, now) {
  const [data, hora] = now.toLocaleString('en-CA', { timeZone: tz, hour12: false }).split(', ')
  const [ano, mes, dia] = data.split('-').map(Number)
  const [h, m] = hora.split(':').map(Number)
  return { ano, mes, dia, hora: h, minuto: m, minutos: h * 60 + m, data }
}

const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate()

// apurações já feitas nesta execução, para não repetir queries a cada 5s
const apurados = new Set()

// Último dia do mês, às 11h15 do grupo: quem mais falou leva o prémio. A 31/12,
// logo a seguir, apura-se também o campeão do ano — pela contagem de meses
// ganhos, não por volume, para premiar constância.
async function monthly(send, now = new Date()) {
  for (const groupId of await settings.getMilestoneGroupIds()) {
    const tz = await settings.getTimezone(groupId)
    const { ano, mes, dia, minutos, data } = partesLocais(tz, now)

    if (dia !== ultimoDiaDoMes(ano, mes)) continue
    if (minutos < APURACAO_MIN) continue

    const chave = `${groupId}:${ano}-${mes}`
    if (apurados.has(chave)) continue
    apurados.add(chave)

    try {
      // campeão do mês
      const doMes = await settings.filterOmitted(groupId, await stats.getMonth(groupId))
      const campeao = leader(doMes)
      if (campeao) {
        const contagem = doMes[campeao]
        const novo = await registerAward({
          type: MENSAL.type,
          category: 'MONTHLY',
          groupId,
          sender: campeao,
          runDay: data,
          periodStart: startOfDay(`${ano}-${String(mes).padStart(2, '0')}-01`, tz),
          periodEnd: now,
          params: [contagem],
        })
        if (novo) {
          log.info({ channel: groupId, sender: campeao, mes: MESES[mes - 1], contagem }, 'campeão do mês')
          const nome = firstName(await contacts.getName(campeao))
          const tipos = resumoTipos(await stats.getMonthTypes(groupId, campeao))
          await send(groupId, montarMensagem(
            MENSAL, nome,
            `Tu fechou *${MESES[mes - 1]}* no topo, com *${contagem} mensagens*!`,
            FESTEJO_MENSAL,
            tipos,
          ))
        }
      }

      // 31 de dezembro: campeão do ano, por número de meses ganhos
      if (mes === 12) await yearly(send, groupId, ano, data, tz, now)
    } catch (err) {
      apurados.delete(chave) // deixa tentar de novo no próximo ciclo
      throw err
    }
  }
}

async function yearly(send, groupId, ano, data, tz, now) {
  let rows = await sql`
    SELECT sender, COUNT(*)::int as meses
    FROM milestone_awards
    WHERE group_id = ${groupId} AND category = 'MONTHLY'
      AND run_day >= ${ano + '-01-01'}::date AND run_day <= ${ano + '-12-31'}::date
    GROUP BY sender ORDER BY meses DESC
  `
  const ocultos = await settings.getOmitted(groupId)
  rows = rows.filter((r) => !ocultos.has(r.sender))
  if (rows.length === 0) return
  if (rows.length > 1 && rows[1].meses === rows[0].meses) {
    log.info({ channel: groupId, ano }, 'campeão do ano empatado — sem prémio')
    return
  }

  const { sender, meses } = rows[0]
  const novo = await registerAward({
    type: ANUAL.type,
    category: 'YEARLY',
    groupId,
    sender,
    runDay: data,
    periodStart: startOfDay(`${ano}-01-01`, tz),
    periodEnd: now,
    params: [meses],
  })
  if (!novo) return

  log.info({ channel: groupId, sender, ano, meses }, 'campeão do ano')
  const nome = firstName(await contacts.getName(sender))
  await send(groupId, montarMensagem(
    ANUAL, nome,
    `Tu foi o campeão de *${ano}*, com *${meses} ${meses === 1 ? 'mês' : 'meses'}* no topo!`,
    FESTEJO_ANUAL,
  ))
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
      .then(() => monthly(send))
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

// Pontuação dos prémios semanais de um ano (!rank premios). Cada prémio vale
// as janelas que exigiu: BISOU 2, HAT TRICK 3, POKER 4. A soma é feita aqui e
// não em SQL para os pesos viverem num sítio só, o WEEKLY.
// `run_day` é o domingo do apuramento, já na data local do grupo.
async function pontuacao(groupId, ano) {
  const rows = await sql`
    SELECT sender, type, COUNT(*)::int as total
    FROM milestone_awards
    WHERE group_id = ${groupId} AND category = 'WEEKLY'
      AND EXTRACT(YEAR FROM run_day) = ${ano}
    GROUP BY sender, type
  `
  const pesos = Object.fromEntries(WEEKLY.map((d) => [d.type, d.pontos]))
  const porPessoa = new Map()
  for (const r of rows) {
    const atual = porPessoa.get(r.sender) || { sender: r.sender, total: 0, premios: 0 }
    atual.total += (pesos[r.type] || 0) * r.total
    atual.premios += r.total
    porPessoa.set(r.sender, atual)
  }
  return [...porPessoa.values()].sort((a, b) => b.total - a.total)
}

module.exports = { start, poll, weekly, monthly, pontuacao, apurarSemana, gravarSemana, DAILY, WEEKLY, MENSAL, ANUAL }
