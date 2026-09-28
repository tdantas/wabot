const { sql } = require('./db')
const log = require('./logger')

// Presença por receipts de leitura.
//
// O WhatsApp entrega um receipt por mensagem lida: quem passa um dia fora e
// volta a abrir o grupo gera centenas de eventos de uma vez. Guardar um por um
// não é sustentável — e também não é útil, porque o facto interessante não é
// "leu a mensagem X", é "esteve presente por volta das Y".
//
// Duas camadas resolvem isso:
//   1. coalescência em memória, para a rajada não chegar sequer à BD;
//   2. balde de tempo com chave única, que limita a 1 linha por pessoa/grupo
//      por balde e torna a gravação idempotente entre restarts e instâncias.
const BUCKET_MS = parseInt(process.env.PRESENCE_BUCKET_MS || String(5 * 60 * 1000), 10)
const FLUSH_MS = parseInt(process.env.PRESENCE_FLUSH_MS || '30000', 10)

const pending = new Map() // `grupo:pessoa:balde` → { groupId, sender, bucket, events }
// contagem por origem, só para observabilidade: permite ver depois do deploy se
// o sinal de presença do WhatsApp (online/a escrever) está mesmo a chegar
const porOrigem = new Map()
let flushing = false
let timer = null

function bucketOf(date) {
  return new Date(Math.floor(date.getTime() / BUCKET_MS) * BUCKET_MS)
}

// Regista atividade. Não toca na BD: só agrega em memória.
// `origem` é livre — 'escrita', 'leitura', 'reacao', 'edicao', 'online'.
//
// O contador `events` é a intensidade do quadrado no heatmap, e por isso conta
// ações: escrever, reagir, editar, apagar. O 'online' (estar com o grupo
// aberto, estar a escrever) vale 1 por balde e não mais: o indicador de "a
// escrever" dispara dezenas de vezes numa mensagem longa, e sem este limite o
// mapa mostraria quem escreve devagar em vez de quem faz mais coisas.
// participação vs. presença passiva — é o que permite ver quem lê mais do que
// participa
const PASSIVAS = new Set(['leitura', 'online'])

function seen(groupId, sender, at = new Date(), origem = 'outro') {
  // O JID do grupo não é uma pessoa: aparecia quando `key.participant` vinha
  // vazio e o chamador caía no `remoteJid`, criando um "membro" com o nome do
  // grupo nas listas.
  if (!groupId || !sender || sender === groupId) return
  porOrigem.set(origem, (porOrigem.get(origem) || 0) + 1)
  const bucket = bucketOf(at)
  const key = `${groupId}:${sender}:${bucket.getTime()}`
  const passiva = PASSIVAS.has(origem)
  const entry = pending.get(key)

  if (!entry) {
    pending.set(key, {
      groupId, sender, bucket,
      events: 1,
      actions: passiva ? 0 : 1,
      passive: passiva ? 1 : 0,
      online: origem === 'online',
    })
    return
  }
  if (origem === 'online') {
    if (entry.online) return // já contado neste balde
    entry.online = true
  }
  entry.events++
  if (passiva) entry.passive++
  else entry.actions++
}

// Grava os baldes acumulados. Um balde já existente só soma os eventos novos.
async function flush() {
  if (flushing || pending.size === 0) return
  flushing = true
  const batch = [...pending.entries()]
  const rows = batch.map(([, e]) => ({
    group_id: e.groupId,
    sender: e.sender,
    bucket: e.bucket,
    events: e.events,
    actions: e.actions,
    passive: e.passive,
  }))
  try {
    await sql`
      INSERT INTO presence ${sql(rows, 'group_id', 'sender', 'bucket', 'events', 'actions', 'passive')}
      ON CONFLICT (group_id, sender, bucket)
      DO UPDATE SET events = presence.events + EXCLUDED.events,
                    actions = presence.actions + EXCLUDED.actions,
                    passive = presence.passive + EXCLUDED.passive
    `
    for (const [key] of batch) pending.delete(key)
    log.info({
      baldes: rows.length,
      sinais: rows.reduce((a, r) => a + r.events, 0),
      origens: Object.fromEntries(porOrigem),
    }, 'presença gravada')
    porOrigem.clear()
  } catch (err) {
    // fica pendente para a próxima ronda em vez de se perder
    log.error({ err, pendentes: pending.size }, 'Falha ao gravar presença')
  } finally {
    flushing = false
  }
}

function start() {
  if (timer) return
  timer = setInterval(() => { flush() }, FLUSH_MS)
  timer.unref()
  log.info({ balde: BUCKET_MS / 1000 + 's', flush: FLUSH_MS / 1000 + 's' }, 'Registo de presença iniciado')
}

function size() {
  return pending.size
}

module.exports = { seen, flush, start, size, bucketOf, BUCKET_MS, FLUSH_MS }
