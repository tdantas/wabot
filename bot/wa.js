require('dotenv').config()

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const log = require('./logger')
const monitor = require('./monitor')
const { init } = require('./db')
const stats = require('./stats')
const commands = require('./commands')
const contacts = require('./contacts')
const ratelimit = require('./ratelimit')
const settings = require('./settings')

// garante que as tabelas existem
init()

const pending = require('./pending')

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

async function start() {
  const AUTH_DIR = process.env.AUTH_DIR || 'auth_info'
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
  })

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update']

      if (qr) {
        log.info('Escaneie o QR Code com WhatsApp (Aparelhos Conectados):')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut

        log.warn(`Conexão fechada (status ${statusCode})`)

        if (!loggedOut) {
          log.info('Reconectando...')
          start()
        } else {
          log.error('Deslogado. Apague a pasta auth_info/ e rode novamente.')
        }
      }

      if (connection === 'open') {
        log.info('Conectado ao WhatsApp!')

        // seed DB from config.json on first run
        const config = loadConfig()
        if (settings.seedFromConfig(config)) {
          log.info('Configuração migrada de config.json para a base de dados')
        }

        // sync commands to DB
        settings.syncCommands(commands.getCommandList())

        // sync all groups and their participants
        const groups = await sock.groupFetchAllParticipating()
        for (const g of Object.values(groups)) {
          contacts.set(g.id, g.subject)
          settings.ensureGroup(g.id)
          for (const p of g.participants) {
            if (p.notify) contacts.set(p.id, p.notify)
          }
        }

        const listening = settings.getListeningGroupIds()
        if (listening.length === 0) {
          log.warn('Nenhum grupo configurado para escuta. Use a interface web para ativar grupos.')
          return
        }

        const groupNames = listening.map((id) => contacts.getName(id))
        log.info({ groups: groupNames }, `Monitorando ${listening.length} grupo(s). Aguardando mensagens...`)
      }
    }

    if (events['creds.update']) {
      await saveCreds()
    }

    // bot adicionado a um grupo
    if (events['group-participants.update']) {
      for (const event of events['group-participants.update']) {
        if (event.action !== 'add') continue

        const botJid = sock.user?.id?.replace(/:\d+@/, '@')
        const wasAdded = event.participants.some(p => p.replace(/:\d+@/, '@') === botJid)
        if (!wasAdded) continue

        const groupId = event.id
        log.info({ groupId }, 'Bot adicionado a um grupo')

        try {
          // 1. registar grupo na DB
          const meta = await sock.groupMetadata(groupId)
          contacts.set(groupId, meta.subject)
          settings.ensureGroup(groupId)

          // sync participants
          for (const p of meta.participants) {
            if (p.notify) contacts.set(p.id, p.notify)
          }

          log.info({ groupId, name: meta.subject }, 'Grupo registado na DB')

          // 2. mensagem de boas-vindas
          await sock.sendMessage(groupId, {
            text: `Olá! Sou o *ZapRats* 📱🐀\n\Digita !live para descobrir o campeão do grupo em mensagens.`
          })

          // 3. notificar admin
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

    // histórico recebido ao reconectar (mensagens offline)
    if (events['messaging-history.set']) {
      const monitoredGroups = new Set(settings.getListeningGroupIds())
      const { messages } = events['messaging-history.set']

      let count = 0
      for (const msg of messages) {
        const from = msg.key.remoteJid
        if (!monitoredGroups.has(from)) continue

        // ignora respostas programáticas do bot (fromMe sem participant e sem pushName)
        if (msg.key.fromMe && !msg.key.participant && !msg.pushName) continue

        const sender = msg.key.participant || (msg.key.fromMe ? sock.user.id : from)
        const pushName = msg.pushName
        if (pushName) contacts.set(sender, pushName)

        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || ''

        const hasMedia = !!(msg.message?.imageMessage
          || msg.message?.videoMessage
          || msg.message?.audioMessage
          || msg.message?.stickerMessage
          || msg.message?.documentMessage)

        if (!text && !hasMedia) continue
        if (text && commands.parse(text)) continue

        stats.track(from, sender)
        count++
      }

      if (count > 0) {
        log.info(`Histórico offline: ${count} mensagens contabilizadas`)
      }
    }

    // contabiliza reações como mensagens
    if (events['messages.reaction']) {
      const monitoredGroups = new Set(settings.getListeningGroupIds())

      for (const { key, reaction } of events['messages.reaction']) {
        const from = key.remoteJid
        if (!monitoredGroups.has(from)) continue

        const sender = reaction.key?.participant || reaction.key?.remoteJid
        if (!sender) continue

        // ignora remoção de reação (texto vazio)
        if (!reaction.text) continue

        // ignora reações do próprio bot
        const botJid = sock.user?.id?.replace(/:\d+@/, '@')
        if (sender.replace(/:\d+@/, '@') === botJid) continue

        log.info({ channel: from, group: contacts.getName(from), user: contacts.getName(sender) }, `${reaction.text} (reação)`)
        stats.track(from, sender)
      }
    }

    if (events['messages.upsert']) {
      const config = loadConfig()
      const monitoredGroups = new Set(settings.getListeningGroupIds())
      const { messages } = events['messages.upsert']

      for (const msg of messages) {
        const from = msg.key.remoteJid

        // só processa mensagens dos grupos monitorados
        if (!monitoredGroups.has(from)) {
          log.debug({ from, monitoredCount: monitoredGroups.size }, 'Mensagem ignorada: grupo não monitorado')
          continue
        }

        const sender = msg.key.participant || from
        const pushName = msg.pushName
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || ''

        const hasMedia = !!(msg.message?.imageMessage
          || msg.message?.videoMessage
          || msg.message?.audioMessage
          || msg.message?.stickerMessage
          || msg.message?.documentMessage)

        const location = msg.message?.locationMessage

        // atualiza nome do contato
        if (pushName) contacts.set(sender, pushName)

        // verifica se é reply com localização a um pedido pendente
        const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
          || msg.message?.locationMessage?.contextInfo?.stanzaId
        const pendingReq = (location && quotedId) ? pending.get(quotedId) : null
        if (pendingReq && pendingReq.sender !== sender) {
          // ignora localização de outro utilizador
          continue
        }
        if (pendingReq) {
          pending.del(quotedId)

          const { lat, lng } = { lat: location.degreesLatitude, lng: location.degreesLongitude }
          log.info({ channel: from, group: contacts.getName(from), user: contacts.getName(sender) }, `localização recebida (${lat}, ${lng})`)

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

        // ignora mensagens sem conteúdo
        if (!text && !hasMedia && !location) continue

        // ignora respostas programáticas do bot (fromMe sem participant e sem pushName)
        if (msg.key.fromMe && !msg.key.participant && !msg.pushName) continue

        const displayName = contacts.getName(sender)
        const logContent = text || (hasMedia ? '(média)' : '')
        log.info({ channel: from, group: contacts.getName(from), user: displayName }, logContent)

        // comandos só em texto
        const parsed = text ? commands.parse(text) : null
        if (parsed) {
          log.info({ channel: from, group: contacts.getName(from), user: displayName, command: parsed.command, alias: parsed.alias }, 'Comando recebido')
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

          try {
            if (commands.isTroll(from)) {
              const reply = await commands.execute(from, sender, text)
              if (reply) await sock.sendMessage(from, { text: String(reply) }, { quoted })
              continue
            }

            const slow = commands.isSlow(text, from)
            let loadingTimer = null
            let loadingKey = null
            let startTime = Date.now()

            if (slow) {
              const sent = await sock.sendMessage(from, { text: LOADING_FRAMES[0] }, { quoted })
              loadingKey = sent.key
              loadingTimer = startLoadingLoop(sock, from, loadingKey)
            }

            const reply = await commands.execute(from, sender, text)
            log.info({ channel: from, command: parsed.command, hasReply: !!reply }, 'Comando executado')

            if (slow) {
              clearInterval(loadingTimer)
              const elapsed = Date.now() - startTime
              if (elapsed < LOADING_AFTER_COMPLETE) await new Promise(r => setTimeout(r, LOADING_AFTER_COMPLETE - elapsed))
            }

            if (reply?.privateMessage) {
              // send to private chat + react on group message
              const senderJid = sender.includes('@lid') ? sender : sender.replace(/@.*/, '@s.whatsapp.net')
              await sock.sendMessage(senderJid, { text: reply.privateMessage })
              if (reply.groupReply) {
                await sock.sendMessage(from, { text: reply.groupReply }, { quoted })
              }
            } else if (reply?.pendingLocation) {
              const sent = await sock.sendMessage(from, { text: `Boa! Envia a tua localização respondendo a esta mensagem para eu procurar "${reply.query}" perto de ti.` }, { quoted })
              pending.save(sent.key.id, from, sender, 'food', reply.query)
            } else if (reply && loadingKey) {
              await sock.sendMessage(from, { text: String(reply), edit: loadingKey })
            } else if (reply) {
              await sock.sendMessage(from, { text: String(reply) }, { quoted })
            }
          } catch (err) {
            log.error({ err, channel: from, command: parsed.command, user: displayName }, 'Erro ao executar comando')
            try { await sock.sendMessage(from, { text: 'Ocorreu um erro ao processar o comando.' }, { quoted }) } catch (_) {}
          }
        } else {
          // contabiliza apenas mensagens normais (não comandos)
          stats.track(from, sender)
        }
      }
    }
  })
}

// limpa pedidos expirados a cada minuto
setInterval(() => pending.purgeExpired(), 60 * 1000)

monitor.start()

start()
