const log = require('./logger')

// Cache das mensagens que o bot enviou.
//
// Quando o telemóvel de alguém não consegue decifrar uma mensagem nossa, o
// WhatsApp devolve um retry receipt a pedir o reenvio. A Baileys precisa do
// conteúdo original para o cifrar de novo e chama `getMessage`. O cache interno
// dela só guarda 512 mensagens durante 5 minutos e não sobrevive a restart —
// passado isso, a mensagem fica em "Waiting for this message" para sempre.
const MAX = parseInt(process.env.MSG_CACHE_SIZE || '2000', 10)
const TTL_MS = parseInt(process.env.MSG_CACHE_TTL_MS || String(60 * 60 * 1000), 10)

const sent = new Map() // id → { message, at }

function save(id, message) {
  if (!id || !message) return
  sent.set(id, { message, at: Date.now() })
  // Map mantém a ordem de inserção: os primeiros são sempre os mais antigos
  while (sent.size > MAX) sent.delete(sent.keys().next().value)
}

function get(id) {
  const entry = sent.get(id)
  if (!entry) return undefined
  if (Date.now() - entry.at > TTL_MS) {
    sent.delete(id)
    return undefined
  }
  return entry.message
}

function size() {
  return sent.size
}

// Embrulha o socket para guardar tudo o que sai, seja qual for o sítio do
// código que envia — assim não é preciso lembrar disto em cada sendMessage.
function track(sock) {
  const original = sock.sendMessage.bind(sock)
  sock.sendMessage = async (jid, content, options) => {
    const result = await original(jid, content, options)
    if (result?.key?.id && result.message) save(result.key.id, result.message)
    return result
  }
  log.info({ max: MAX, ttlMin: Math.round(TTL_MS / 60000) }, 'Cache de mensagens enviadas ativo')
  return sock
}

module.exports = { save, get, size, track, MAX, TTL_MS }
