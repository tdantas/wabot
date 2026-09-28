require('dotenv').config()

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const log = require('./logger')
const monitor = require('./monitor')
const { init, sql } = require('./db')
const stats = require('./stats')
const milestone = require('./milestone')
const { ACTIVITY_TYPES } = stats
const commands = require('./commands')
const contacts = require('./contacts')
const ratelimit = require('./ratelimit')
const settings = require('./settings')
const pending = require('./pending')
const msgstore = require('./msgstore')
const presence = require('./presence')

const baileysLogger = pino({ level: 'silent' })
const CONFIG_PATH = path.join(__dirname, 'config.json')

// loading bar
const LOADING_INTERVAL = 1000
const LOADING_AFTER_COMPLETE = 1000

const LOADING_FRAMES = [
  '━●━━━━━━━',
  '━━●━━━━━━',
  '━━━●━━━━━',
  '━━━━●━━━━',
  '━━━━━●━━━',
  '━━━━━━●━━',
  '━━━━━━━●━',
  '━━━━━━━━●',
]

function startLoadingLoop(sock, from, key) {
  let i = 0
  let direction = 1
  const timer = setInterval(async () => {
    try { await sock.sendMessage(from, { text: LOADING_FRAMES[i], edit: key }) } catch (_) {}
    i += direction
    if (i >= LOADING_FRAMES.length) { direction = -1; i = LOADING_FRAMES.length - 2 }
    else if (i < 0) { direction = 1; i = 1 }
  }, LOADING_INTERVAL)
  return timer
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
}

const AUTH_DIR = process.env.AUTH_DIR || 'auth_info'

// socket em uso; trocado a cada reconexão
let activeSock = null

// Depois de um logout (401) as credenciais guardadas não servem para nada: com
// elas presentes a Baileys volta a falhar em vez de emitir um QR novo, e o bot
// fica em silêncio à espera de intervenção manual. Limpar e reiniciar é o que
// faz aparecer o QR — no log e na UI.
function limparCredenciais() {
  try {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true })
    }
    return true
  } catch (err) {
    log.error({ err, AUTH_DIR }, 'Falha ao limpar credenciais')
    return false
  }
}

// --- rajadas de stickers ---
// Uma sequência de figurinhas em segundos não é conversa: inflaciona o ranking
// e o heatmap sem representar participação. Numa janela de 15s contam-se no
// máximo 4; quem mandar menos, conta o que mandou.
// O subtipo só é conhecido aqui — na base tudo vira MEDIA_MESSAGE.
const STICKER_JANELA_MS = parseInt(process.env.STICKER_JANELA_MS || '15000', 10)
const STICKER_MAX = parseInt(process.env.STICKER_MAX || '4', 10)
const janelaSticker = new Map() // `grupo:pessoa` → { inicio, contados }

function stickerEmRajada(groupId, sender, at) {
  const chave = `${groupId}:${sender}`
  const janela = janelaSticker.get(chave)

  // fora da janela (ou primeira figurinha): abre uma nova
  if (!janela || at - janela.inicio >= STICKER_JANELA_MS) {
    janelaSticker.set(chave, { inicio: at, contados: 1 })
    return false
  }
  if (janela.contados < STICKER_MAX) {
    janela.contados++
    return false
  }
  return true // teto atingido nesta janela
}

// Quanto do histórico entregue pelo WhatsApp é aproveitado. Recuperar o
// intervalo em que o bot esteve fora é o objetivo; reescrever meses de
// conversa antiga não é.
const HISTORY_MAX_DIAS = parseInt(process.env.HISTORY_MAX_DIAS || '14', 10)

// O sinal de presença (online / a escrever) só chega para grupos subscritos, e
// a subscrição não é eterna. Repetimos periodicamente, o que também apanha os
// grupos ativados na UI depois do arranque.
const PRESENCE_SUBSCRIBE_MS = parseInt(process.env.PRESENCE_SUBSCRIBE_MS || String(10 * 60 * 1000), 10)

// Relê nomes de grupos e participantes. Sem isto, uma pessoa que muda o nome
// no WhatsApp continua a aparecer com o antigo até voltar a escrever, porque
// o `pushName` só chega nas mensagens dela.
const CONTACTS_SYNC_MS = parseInt(process.env.CONTACTS_SYNC_MS || String(6 * 60 * 60 * 1000), 10)

async function syncContacts({ ensure = false } = {}) {
  if (!activeSock) return
  let pessoas = 0
  const groups = await activeSock.groupFetchAllParticipating()
  for (const g of Object.values(groups)) {
    await contacts.set(g.id, g.subject)
    if (ensure) await settings.ensureGroup(g.id)
    for (const p of g.participants) {
      if (p.notify) {
        await contacts.set(p.id, p.notify)
        pessoas++
      }
    }
  }
  log.info({ grupos: Object.keys(groups).length, pessoas }, 'Nomes sincronizados')
}

async function subscribePresence() {
  if (!activeSock) return
  const grupos = await settings.getListeningGroupIds()
  let ok = 0
  for (const gid of grupos) {
    try {
      await activeSock.presenceSubscribe(gid)
      ok++
    } catch (err) {
      log.debug({ err, gid }, 'falha ao subscrever presença')
    }
  }
  log.debug({ grupos: ok }, 'subscrição de presença renovada')
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  log.info(`Usando WA Web v${version.join('.')}`)

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    // O WhatsApp entrega o histórico recente no emparelhamento e depois de
    // períodos offline. Recusá-lo era o motivo de as mensagens do intervalo se
    // perderem. Aceitamos, e filtramos por data ao processar.
    shouldSyncHistoryMessage: () => true,
    syncFullHistory: false,
    // A conta que corre o bot ficaria "online" 24h por dia, o que falsearia a
    // presença (e faria o WhatsApp deixar de notificar o telemóvel).
    markOnlineOnConnect: false,
    // devolve o conteúdo original quando o WhatsApp pede o reenvio de uma
    // mensagem que alguém não conseguiu decifrar ("Waiting for this message")
    getMessage: async (key) => msgstore.get(key.id),
  })
  // a partir daqui, tudo o que for enviado fica no cache
  msgstore.track(sock)
  activeSock = sock

  // Um erro num ramo não pode derrubar o processo: sem este catch a promise
  // rejeitada chega ao Node como unhandled rejection e o bot sai.
  sock.ev.process((events) => (async () => {
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update']

      if (qr) {
        monitor.setStatus({ connection: 'qr', loggedOut: true })
        log.info('Escaneie o QR Code com WhatsApp (Aparelhos Conectados):')
        qrcode.generate(qr, { small: true })

        // publica o mesmo QR para a UI: ter de ir ao terminal do servidor para
        // recuperar a sessão é o pior momento para depender de acesso SSH
        try {
          const png = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
          await sql`
            INSERT INTO bot_metrics (key, value, updated_at) VALUES ('wa_qr', ${png}, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `
        } catch (err) {
          log.error({ err }, 'Falha ao publicar QR')
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut

        monitor.setStatus({ connection: 'close', statusCode, loggedOut })
        log.warn(`Conexão fechada (status ${statusCode})`)

        if (!loggedOut) {
          log.info('Reconectando...')
          start()
        } else {
          log.error('Sessão terminada pelo WhatsApp. A limpar credenciais e a pedir novo QR...')
          if (limparCredenciais()) {
            // o arranque seguinte não encontra credenciais e emite o QR
            setTimeout(() => start().catch(err => log.error({ err }, 'Falha ao reiniciar após logout')), 3000)
          } else {
            log.error(`Não foi possível limpar ${AUTH_DIR}. Apaga o conteúdo à mão e reinicia.`)
          }
        }
      }

      if (connection === 'open') {
        monitor.setStatus({ connection: 'open', statusCode: null, loggedOut: false })
        log.info('Conectado ao WhatsApp!')
        // sessão estabelecida: o QR publicado deixa de servir
        try { await sql`DELETE FROM bot_metrics WHERE key = 'wa_qr'` } catch (_) {}

        // seed DB from config.json on first run
        const config = loadConfig()
        if (await settings.seedFromConfig(config)) {
          log.info('Configuração migrada de config.json para a base de dados')
        }

        // sync commands to DB
        await settings.syncCommands(commands.getCommandList())

        // sync all groups and their participants
        await syncContacts({ ensure: true })

        const listening = await settings.getListeningGroupIds()
        if (listening.length === 0) {
          log.warn('Nenhum grupo configurado para escuta. Use a interface web para ativar grupos.')
          return
        }

        // sem subscrever, o WhatsApp não envia presença dos participantes
        await subscribePresence()

        const groupNames = await Promise.all(listening.map(id => contacts.getName(id)))
        log.info({ groups: groupNames }, `Monitorando ${listening.length} grupo(s). Aguardando mensagens...`)
      }
    }

    if (events['creds.update']) {
      await saveCreds()
    }

    // Histórico entregue pelo WhatsApp: recupera o que aconteceu enquanto o bot
    // esteve fora. O `stats.track` é idempotente pelo message_id, por isso o
    // que já conhecemos não duplica.
    if (events['messaging-history.set']) {
      const { messages = [] } = events['messaging-history.set']
      const monitoredGroups = new Set(await settings.getListeningGroupIds())
      const limite = Date.now() - HISTORY_MAX_DIAS * 24 * 60 * 60 * 1000
      let recuperadas = 0

      for (const msg of messages) {
        const from = msg.key?.remoteJid
        if (!from || !monitoredGroups.has(from)) continue
        if (msg.key.fromMe && !msg.key.participant) continue

        const ts = Number(msg.messageTimestamp) * 1000
        if (!ts || ts < limite) continue

        const autor = contacts.toLid(msg.key.participant || from)
        if (!autor || autor === from) continue

        const kind =
          msg.message?.stickerMessage ? 'sticker'
          : msg.message?.imageMessage ? 'image'
          : msg.message?.videoMessage ? 'video'
          : msg.message?.audioMessage ? 'audio'
          : msg.message?.documentMessage ? 'document'
          : null
        const temTexto = !!(msg.message?.conversation || msg.message?.extendedTextMessage?.text)
        if (!kind && !temTexto) continue

        try {
          await stats.track(from, autor, kind ? ACTIVITY_TYPES.MEDIA_MESSAGE : ACTIVITY_TYPES.TEXT_MESSAGE,
            msg.key.id, msg.messageTimestamp, kind)
          // Sem presença aqui: o `presence.seen` soma no balde e o histórico
          // traz mensagens que já conhecemos, o que inflacionaria as ações.
          // A presença destes dias reconstrói-se com `backfill-presence.js`,
          // que usa GREATEST e nunca duplica.
          recuperadas++
        } catch (err) {
          log.debug({ err, id: msg.key.id }, 'falha ao recuperar mensagem do histórico')
        }
      }

      if (recuperadas > 0) {
        log.info({ recuperadas, recebidas: messages.length, dias: HISTORY_MAX_DIAS }, 'Histórico recuperado')
      }
    }

    // capture JID→LID mappings from contacts updates
    if (events['contacts.update']) {
      for (const contact of events['contacts.update']) {
        if (contact.id && contact.lid) {
          await contacts.mapJid(contact.id, contact.lid)
        }
      }
    }
    if (events['contacts.upsert']) {
      for (const contact of events['contacts.upsert']) {
        if (contact.id && contact.lid) {
          await contacts.mapJid(contact.id, contact.lid)
        }
      }
    }

    // bot adicionado a um grupo
    if (events['group-participants.update']) {
      const gpUpdates = Array.isArray(events['group-participants.update']) ? events['group-participants.update'] : [events['group-participants.update']]
      for (const event of gpUpdates) {
        if (event.action !== 'add') continue

        // Na Baileys 7 cada participante é { id, phoneNumber, admin } — o `id`
        // pode ser o LID e o número vir à parte; versões antigas mandavam só
        // a string do jid. O bot pode aparecer por qualquer das duas formas.
        const semDevice = (jid) => (typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : null)
        const botJids = new Set([semDevice(sock.user?.id), semDevice(sock.user?.lid)].filter(Boolean))
        const wasAdded = (event.participants || []).some((p) => (
          typeof p === 'string'
            ? botJids.has(semDevice(p))
            : botJids.has(semDevice(p?.id)) || botJids.has(semDevice(p?.phoneNumber))
        ))
        if (!wasAdded) continue

        const groupId = event.id
        log.info({ groupId }, 'Bot adicionado a um grupo')

        try {
          const meta = await sock.groupMetadata(groupId)
          await contacts.set(groupId, meta.subject)
          await settings.ensureGroup(groupId)

          for (const p of meta.participants) {
            if (p.notify) await contacts.set(p.id, p.notify)
          }

          log.info({ groupId, name: meta.subject }, 'Grupo registado na DB')

          await sock.sendMessage(groupId, {
            text: `Olá! Digita !live para ver o Group Usage Report.`
          })

          const adminNumber = process.env.ADMIN_PHONE
          if (adminNumber) {
            const adminJid = adminNumber.includes('@') ? adminNumber : `${adminNumber}@s.whatsapp.net`
            await sock.sendMessage(adminJid, {
              text: `🔔 Bot adicionado ao grupo:\n*${meta.subject}*\n\nID: ${groupId}\nParticipantes: ${meta.participants.length}`
            })
          }
        } catch (err) {
          log.error({ err, groupId }, 'Erro ao processar adição a grupo')
        }
      }
    }

// contabiliza reações como mensagens
    if (events['messages.reaction']) {
      const monitoredGroups = new Set(await settings.getListeningGroupIds())

      for (const { key, reaction } of events['messages.reaction']) {
        const from = key.remoteJid
        if (!monitoredGroups.has(from)) continue

        // sem `participant` não sabemos quem reagiu; o `remoteJid` seria o grupo
        const sender = contacts.toLid(reaction.key?.participant)
        if (!sender || sender === from) continue

        if (!reaction.text) continue

        const botJid = sock.user?.id?.replace(/:\d+@/, '@')
        if (sender.replace(/:\d+@/, '@') === botJid) continue

        log.info({ channel: from, group: await contacts.getName(from), sender, user: await contacts.getName(sender) }, `${reaction.text} (reação)`)
        presence.seen(from, sender, new Date(), 'reacao')
        await stats.track(from, sender, ACTIVITY_TYPES.REACTION)
      }
    }

    // editar ou apagar uma mensagem também é atividade: chegam em
    // messages.update (o protocolMessage é traduzido pela Baileys)
    if (events['messages.update']) {
      const monitoredGroups = new Set(await settings.getListeningGroupIds())

      for (const { key, update } of events['messages.update']) {
        const from = key?.remoteJid
        if (!from || !monitoredGroups.has(from)) continue

        // Qualquer atualização de mensagem nossa é ignorada. A barra de loading
        // edita a mensagem do bot uma vez por segundo, e o `!key.participant`
        // não chega para a apanhar: nas edições em grupo a chave costuma trazer
        // o participante preenchido. O preço é perder as edições que a pessoa
        // faça do telemóvel na mesma conta — raras, ao lado do ruído do bot.
        if (key.fromMe) continue

        const autor = contacts.toLid(update?.key?.participant || key.participant)
        if (!autor) continue

        // apagar chega com `message: null`; editar traz o conteúdo novo
        const apagou = update?.message === null
        presence.seen(from, autor, new Date(), apagou ? 'remocao' : 'edicao')
        log.debug({ channel: from, sender: autor }, apagou ? 'apagou mensagem' : 'editou mensagem')
      }
    }

    // Presença do WhatsApp: online, a escrever, a gravar áudio.
    // A conta que corre o bot não é excluída: com `markOnlineOnConnect: false`
    // o processo não anuncia presença, por isso um "online" desta conta vem
    // mesmo do telemóvel da pessoa. (Se algum dia essa opção voltar a `true`,
    // esta conta passa a aparecer online 24h e o filtro tem de voltar.)
    if (events['presence.update']) {
      const monitoredGroups = new Set(await settings.getListeningGroupIds())
      const { id, presences } = events['presence.update']

      if (monitoredGroups.has(id)) {
        for (const [participante, info] of Object.entries(presences || {})) {
          // 'unavailable' é a saída, não conta como estar presente
          if (!['available', 'composing', 'recording'].includes(info?.lastKnownPresence)) continue
          const quem = contacts.toLid(participante)
          if (!quem) continue
          presence.seen(id, quem, new Date(), 'online')
        }
      }
    }

    // logging de receipts de leitura
    if (events['message-receipt.update']) {
      const monitoredGroups = new Set(await settings.getListeningGroupIds())

      for (const { key, receipt } of events['message-receipt.update']) {
        const from = key.remoteJid
        if (!monitoredGroups.has(from)) continue
        if (!receipt.readTimestamp) continue

        const reader = contacts.toLid(receipt.userJid)
        if (!reader) continue

        // só agrega em memória: uma pessoa que volta e lê 200 mensagens gera
        // 200 receipts, mas apenas um registo de presença
        presence.seen(from, reader, new Date(Number(receipt.readTimestamp) * 1000), 'leitura')
        log.debug({ channel: from, sender: reader }, 'leu mensagem')
      }
    }

    if (events['messages.upsert']) {
      const config = loadConfig()
      const monitoredGroups = new Set(await settings.getListeningGroupIds())
      const { messages } = events['messages.upsert']

      for (const msg of messages) {
        const from = msg.key.remoteJid

        if (!monitoredGroups.has(from)) {
          log.debug({ from, monitoredCount: monitoredGroups.size }, 'Mensagem ignorada: grupo não monitorado')
          continue
        }

        const sender = contacts.toLid(msg.key.participant || from)
        const pushName = msg.pushName
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || ''

        // o subtipo só existe aqui: na base tudo vira MEDIA_MESSAGE
        const mediaKind =
          msg.message?.stickerMessage ? 'sticker'
          : msg.message?.imageMessage ? 'image'
          : msg.message?.videoMessage ? 'video'
          : msg.message?.audioMessage ? 'audio'
          : msg.message?.documentMessage ? 'document'
          : null
        const hasMedia = mediaKind !== null

        const location = msg.message?.locationMessage

        // atualiza nome do contato
        if (pushName) await contacts.set(sender, pushName)

        // verifica se é reply com localização a um pedido pendente
        const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
          || msg.message?.locationMessage?.contextInfo?.stanzaId
        const pendingReq = (location && quotedId) ? await pending.get(quotedId) : null
        if (pendingReq && pendingReq.sender !== sender) {
          continue
        }
        if (pendingReq) {
          await pending.del(quotedId)

          const { lat, lng } = { lat: location.degreesLatitude, lng: location.degreesLongitude }
          log.info({ channel: from, group: await contacts.getName(from), user: await contacts.getName(sender) }, `localização recebida (${lat}, ${lng})`)

          try {
            const gemini = require('./gemini')
            const foodSent = await sock.sendMessage(from, { text: '●━━━━━━━━━━━' }, { quoted: msg })
            const foodStart = Date.now()
            const foodTimer = startLoadingLoop(sock, from, foodSent.key)
            const reply = await gemini.ask(
              `Pesquisa "${pendingReq.query}" perto da minha localização. Quero restaurantes reais, com nome, morada e avaliação.`,
              'food',
              null,
              { location: { lat, lng } }
            )
            clearInterval(foodTimer)
            const foodElapsed = Date.now() - foodStart
            if (foodElapsed < LOADING_AFTER_COMPLETE) await new Promise(r => setTimeout(r, LOADING_AFTER_COMPLETE - foodElapsed))
            const response = String(reply).trim() || 'Não encontrei resultados para essa pesquisa. Tenta com outro tipo de restaurante.'
            await sock.sendMessage(from, { text: `${response}\n\n_Chapa Soft Brand, powered by Okivia Group_`, edit: foodSent.key })
          } catch (err) {
            log.error({ err }, 'Erro Gemini food')
            await sock.sendMessage(from, { text: 'Erro ao pesquisar. Tente novamente.' }, { quoted: msg })
          }
          continue
        }

        if (!text && !hasMedia && !location) continue

        // ignore bot's own automated replies
        if (msg.key.fromMe && !msg.key.participant) continue

        // Só a partir daqui é atividade de gente: a Baileys reemite as
        // mensagens que o próprio bot envia (emitOwnEvents), e cada frame da
        // barra de loading é um envio. Marcar presença antes deste filtro
        // enchia o mapa da conta que corre o bot.
        const quando = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date()

        // figurinha em rajada: conta a primeira, ignora as seguintes
        const rajada = mediaKind === 'sticker' && stickerEmRajada(from, sender, quando.getTime())
        if (rajada) {
          log.debug({ channel: from, sender }, 'sticker em rajada ignorado')
        } else {
          presence.seen(from, sender, quando, 'escrita')
        }

        const displayName = await contacts.getName(sender)
        const logContent = text || (hasMedia ? '(média)' : '')
        log.info({ channel: from, group: await contacts.getName(from), sender, user: displayName }, logContent)

        // comandos só em texto
        const parsed = text ? commands.parse(text) : null
        if (parsed) {
          log.info({ channel: from, group: await contacts.getName(from), sender, user: displayName, command: parsed.command, alias: parsed.alias }, 'Comando recebido')
          const MINUTE = 60 * 1000
          const rl = config.rateLimit || {}

          const userCheck = ratelimit.check(`user:${sender}`, rl.userMaxPerMinute || 2, MINUTE)
          if (!userCheck.allowed) {
            await sock.sendMessage(from, { text: `Calma! Aguarda ${userCheck.waitSec}s antes de enviar outro comando.` })
            continue
          }

          const groupCheck = ratelimit.check(`group:${from}`, rl.groupMaxPerMinute || 10, MINUTE)
          if (!groupCheck.allowed) {
            await sock.sendMessage(from, { text: `O grupo atingiu o limite de comandos. Aguardem ${groupCheck.waitSec}s.` })
            continue
          }

          const quoted = msg

          // --- resumo command (premium only) ---
          if (parsed.command === 'resumo') {
            const isPremium = await settings.isPremium(from, sender)
            if (!isPremium) {
              await sock.sendMessage(from, { text: 'Essa funcionalidade é exclusiva para usuários premium. Entre em contato para fazer upgrade do seu plano.' }, { quoted: msg })
              continue
            }

            // Extract URL from args or from quoted message
            let rawUrl = parsed.args.find(a => a.match(/^https?:\/\//))
            if (!rawUrl) {
              const quotedText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
                || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text
                || ''
              const urlMatch = quotedText.match(/https?:\/\/[^\s]+/)
              if (urlMatch) rawUrl = urlMatch[0]
            }
            if (!rawUrl) {
              await sock.sendMessage(from, { text: 'Uso: !resumo <link> ou responda a uma mensagem com link' }, { quoted: msg })
              continue
            }

            // Validate URL safety: only allow article/text pages and YouTube
            const BLOCKED_EXTENSIONS = /\.(exe|msi|bat|cmd|sh|ps1|dll|bin|iso|dmg|apk|ipa|jar|war|swf|flv|zip|rar|7z|tar|gz|bz2|js|ts|py|rb|php|asp|jsp|cgi|sql|csv|xml|json|pdf|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|mkv|wav|ogg|flac|jpg|jpeg|png|gif|bmp|svg|webp|tiff)(\?.*)?$/i
            const ALLOWED_DOMAINS_YOUTUBE = /^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)$/
            try {
              const parsedUrl = new URL(rawUrl)
              const hostname = parsedUrl.hostname.toLowerCase()
              const pathname = parsedUrl.pathname.toLowerCase()
              const isYoutube = ALLOWED_DOMAINS_YOUTUBE.test(hostname)
              const hasBlockedExt = BLOCKED_EXTENSIONS.test(pathname)

              if (!isYoutube && hasBlockedExt) {
                await sock.sendMessage(from, { text: 'Apenas links de artigos ou vídeos do YouTube são suportados.' }, { quoted: msg })
                continue
              }

              if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
                await sock.sendMessage(from, { text: 'Apenas links HTTP/HTTPS são suportados.' }, { quoted: msg })
                continue
              }

              // Block localhost, private IPs, internal networks
              if (hostname === 'localhost' || hostname.match(/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/)) {
                await sock.sendMessage(from, { text: 'Link inválido.' }, { quoted: msg })
                continue
              }
            } catch {
              await sock.sendMessage(from, { text: 'Link inválido.' }, { quoted: msg })
              continue
            }

            // Canonical URL: remove tracking params, fragment, normalize
            const crypto = require('crypto')
            const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'source']
            let canonical
            try {
              const u = new URL(rawUrl)
              TRACKING_PARAMS.forEach(p => u.searchParams.delete(p))
              u.hash = ''
              canonical = u.toString().replace(/\/+$/, '')
            } catch { canonical = rawUrl }
            const urlHash = crypto.createHash('md5').update(canonical).digest('hex')

            const sent = await sock.sendMessage(from, { text: LOADING_FRAMES[0] }, { quoted: msg })
            const loadingTimer = startLoadingLoop(sock, from, sent.key)
            const startTime = Date.now()

            try {
              const [cached] = await sql`SELECT summary FROM summaries WHERE url_hash = ${urlHash}`

              let summary
              if (cached) {
                summary = cached.summary
                log.info({ urlHash, canonical, sender, channel: from }, 'Resumo: cache hit')
              } else {
                const gemini = require('./gemini')
                summary = await gemini.summarize(canonical)
                const FAIL_PHRASES = ['não foi possível', 'não é suportado', 'not available', 'could not']
                const isFail = !summary || FAIL_PHRASES.some(p => summary.toLowerCase().includes(p))
                if (summary && !isFail) {
                  await sql`INSERT INTO summaries (url_hash, canonical_url, summary) VALUES (${urlHash}, ${canonical}, ${summary}) ON CONFLICT DO NOTHING`
                }
              }

              clearInterval(loadingTimer)
              const elapsed = Date.now() - startTime
              if (elapsed < LOADING_AFTER_COMPLETE) await new Promise(r => setTimeout(r, LOADING_AFTER_COMPLETE - elapsed))

              await sock.sendMessage(from, { text: summary || 'Não foi possível resumir este artigo.', edit: sent.key })
            } catch (err) {
              clearInterval(loadingTimer)
              log.error({ err }, 'Erro resumo')
              await sock.sendMessage(from, { text: 'Erro ao resumir o artigo. Verifique se o link é válido e tente novamente.', edit: sent.key })
            }
            continue
          }

          // --- transcript command (needs access to msg) ---
          if (parsed.command === 'transcript') {
            const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            const audioMessage = quotedMessage?.audioMessage

            if (!audioMessage) {
              await sock.sendMessage(from, { text: 'Responda a uma mensagem de áudio com !transcript' }, { quoted: msg })
              continue
            }

            // check audio duration before processing
            const audioDuration = audioMessage.seconds || 0
            const maxSeconds = await settings.getTranscriptMaxSeconds(from)
            if (audioDuration > maxSeconds) {
              await sock.sendMessage(from, {
                text: `Este áudio tem ${audioDuration}s mas o limite atual é de ${maxSeconds}s. Para transcrever áudios maiores, faça upgrade do seu plano.`,
              }, { quoted: msg })
              continue
            }

            const sent = await sock.sendMessage(from, { text: LOADING_FRAMES[0] }, { quoted: msg })
            const loadingTimer = startLoadingLoop(sock, from, sent.key)
            const startTime = Date.now()

            try {
              const { downloadMediaMessage } = require('@whiskeysockets/baileys')
              const crypto = require('crypto')
              const gemini = require('./gemini')

              const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
              const quotedMsg = { message: quotedMessage, key: { ...msg.key, id: stanzaId } }

              let buffer
              try {
                buffer = await downloadMediaMessage(quotedMsg, 'buffer', {})
              } catch (dlErr) {
                clearInterval(loadingTimer)
                log.warn({ err: dlErr }, 'Transcript: áudio não disponível')
                await sock.sendMessage(from, {
                  text: 'Não foi possível acessar este áudio. Provavelmente já expirou.\n\nPeça para enviar o áudio novamente e faça !transcript no novo áudio.',
                  edit: sent.key,
                })
                continue
              }

              const audioHash = crypto.createHash('md5').update(buffer).digest('hex')
              const [cached] = await sql`SELECT transcription FROM transcripts WHERE audio_hash = ${audioHash}`

              let transcription
              if (cached) {
                transcription = cached.transcription
                log.info({ audioHash, sender, channel: from }, 'Transcript: cache hit')
              } else {
                // check daily limit before calling API
                const dailyLimit = await settings.getTranscriptDailyLimit(from)
                const usage = await settings.getTranscriptUsage(from, sender)
                if (usage >= dailyLimit) {
                  clearInterval(loadingTimer)
                  await sock.sendMessage(from, {
                    text: `Você atingiu o limite de ${dailyLimit} transcrições por dia. Para mais transcrições, faça upgrade do seu plano.`,
                    edit: sent.key,
                  })
                  continue
                }

                const mimeType = audioMessage.mimetype || 'audio/ogg'
                try {
                  transcription = await gemini.transcribe(buffer, mimeType)
                } catch (aiErr) {
                  clearInterval(loadingTimer)
                  log.error({ err: aiErr }, 'Transcript: erro Gemini')
                  await sock.sendMessage(from, {
                    text: 'Ocorreu um erro ao transcrever o áudio. Tente novamente mais tarde.',
                    edit: sent.key,
                  })
                  continue
                }

                if (transcription) {
                  await sql`INSERT INTO transcripts (audio_hash, transcription) VALUES (${audioHash}, ${transcription}) ON CONFLICT DO NOTHING`
                  await settings.incrementTranscriptUsage(from, sender)
                }
              }

              clearInterval(loadingTimer)
              const elapsed = Date.now() - startTime
              if (elapsed < LOADING_AFTER_COMPLETE) await new Promise(r => setTimeout(r, LOADING_AFTER_COMPLETE - elapsed))

              const reply = transcription
                ? transcription.split('\n').map(l => l.trim() ? `_${l}_` : '').join('\n')
                : 'Não foi possível transcrever este áudio. O conteúdo pode não ser reconhecível.'
              await sock.sendMessage(from, { text: reply, edit: sent.key })
            } catch (err) {
              clearInterval(loadingTimer)
              log.error({ err }, 'Erro transcript')
              await sock.sendMessage(from, { text: 'Ocorreu um erro inesperado. Tente novamente.', edit: sent.key })
            }
            continue
          }

          try {
            if (await commands.isTroll(from)) {
              const reply = await commands.execute(from, sender, text)
              if (reply) await sock.sendMessage(from, { text: String(reply) }, { quoted })
              continue
            }

            const slow = await commands.isSlow(text, from)
            let loadingTimer = null
            let loadingKey = null
            let startTime = Date.now()

            if (slow) {
              const sent = await sock.sendMessage(from, { text: LOADING_FRAMES[0] }, { quoted })
              loadingKey = sent.key
              loadingTimer = startLoadingLoop(sock, from, loadingKey)
            }

            const reply = await commands.execute(from, sender, text)
            log.info({ channel: from, group: await contacts.getName(from), sender, user: displayName, command: parsed.command, hasReply: !!reply }, 'Comando executado')

            if (slow) {
              clearInterval(loadingTimer)
              const elapsed = Date.now() - startTime
              if (elapsed < LOADING_AFTER_COMPLETE) await new Promise(r => setTimeout(r, LOADING_AFTER_COMPLETE - elapsed))
            }

            if (reply?.privateMessage) {
              const senderJid = sender.includes('@lid') ? sender : sender.replace(/@.*/, '@s.whatsapp.net')
              await sock.sendMessage(senderJid, { text: reply.privateMessage })
              if (reply.groupReply) {
                await sock.sendMessage(from, { text: reply.groupReply }, { quoted })
              }
            } else if (reply?.pendingLocation) {
              const sent = await sock.sendMessage(from, { text: `Boa! Envia a tua localização respondendo a esta mensagem para eu procurar "${reply.query}" perto de ti.` }, { quoted })
              await pending.save(sent.key.id, from, sender, 'food', reply.query)
            } else if (reply && loadingKey) {
              await sock.sendMessage(from, { text: String(reply), edit: loadingKey })
            } else if (reply) {
              await sock.sendMessage(from, { text: String(reply) }, { quoted })
            }
          } catch (err) {
            log.error({ err, channel: from, group: await contacts.getName(from), sender, user: displayName, command: parsed.command }, 'Erro ao executar comando')
            try { await sock.sendMessage(from, { text: 'Ocorreu um erro ao processar o comando.' }, { quoted }) } catch (_) {}
          }
        } else {
          // contabiliza apenas mensagens normais (não comandos)
          if (!rajada) {
            await stats.track(from, sender, hasMedia ? ACTIVITY_TYPES.MEDIA_MESSAGE : ACTIVITY_TYPES.TEXT_MESSAGE, msg.key.id, msg.messageTimestamp, mediaKind)
          }
        }
      }
    }
  })().catch((err) => log.error({ err, eventos: Object.keys(events) }, 'Erro ao processar eventos do WhatsApp')))
}

// limpa pedidos expirados a cada minuto
setInterval(async () => {
  try { await pending.purgeExpired() } catch (_) {}
}, 60 * 1000)

// renova a subscrição de presença dos grupos monitorados
setInterval(() => {
  subscribePresence().catch(err => log.debug({ err }, 'erro ao renovar presença'))
}, PRESENCE_SUBSCRIBE_MS)

// relê os nomes: apanha quem mudou o nome no WhatsApp sem voltar a escrever
setInterval(() => {
  syncContacts().catch(err => log.error({ err }, 'erro ao sincronizar nomes'))
}, CONTACTS_SYNC_MS)

monitor.start()

// bootstrap: run migrations then start
init().then(async () => {
  log.info('Migrations aplicadas, a iniciar bot...')
  await contacts.loadLidCache()
  start()
  // parabéns a quem cruzar o marco de mensagens do dia em cada grupo
  milestone.start(async (groupId, text) => {
    if (activeSock) await activeSock.sendMessage(groupId, { text })
  })
  presence.start()
}).catch(err => {
  log.error({ err }, 'Falha ao inicializar base de dados')
  process.exit(1)
})
