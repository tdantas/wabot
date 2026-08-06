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
const { init, sql } = require('./db')
const stats = require('./stats')
const { ACTIVITY_TYPES } = stats
const commands = require('./commands')
const contacts = require('./contacts')
const ratelimit = require('./ratelimit')
const settings = require('./settings')
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
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
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
        if (await settings.seedFromConfig(config)) {
          log.info('Configuração migrada de config.json para a base de dados')
        }

        // sync commands to DB
        await settings.syncCommands(commands.getCommandList())

        // sync all groups and their participants
        const groups = await sock.groupFetchAllParticipating()
        for (const g of Object.values(groups)) {
          await contacts.set(g.id, g.subject)
          await settings.ensureGroup(g.id)
          for (const p of g.participants) {
            if (p.notify) await contacts.set(p.id, p.notify)
          }
        }

        const listening = await settings.getListeningGroupIds()
        if (listening.length === 0) {
          log.warn('Nenhum grupo configurado para escuta. Use a interface web para ativar grupos.')
          return
        }

        const groupNames = await Promise.all(listening.map(id => contacts.getName(id)))
        log.info({ groups: groupNames }, `Monitorando ${listening.length} grupo(s). Aguardando mensagens...`)
      }
    }

    if (events['creds.update']) {
      await saveCreds()
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

        const botJid = sock.user?.id?.replace(/:\d+@/, '@')
        const wasAdded = event.participants.some(p => p.replace(/:\d+@/, '@') === botJid)
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

        const sender = contacts.toLid(reaction.key?.participant || reaction.key?.remoteJid)
        if (!sender) continue

        if (!reaction.text) continue

        const botJid = sock.user?.id?.replace(/:\d+@/, '@')
        if (sender.replace(/:\d+@/, '@') === botJid) continue

        log.info({ channel: from, group: await contacts.getName(from), sender, user: await contacts.getName(sender) }, `${reaction.text} (reação)`)
        await stats.track(from, sender, ACTIVITY_TYPES.REACTION)
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

        log.info({ channel: from, group: await contacts.getName(from), sender: reader, user: await contacts.getName(reader) }, 'leu mensagem')
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

        const hasMedia = !!(msg.message?.imageMessage
          || msg.message?.videoMessage
          || msg.message?.audioMessage
          || msg.message?.stickerMessage
          || msg.message?.documentMessage)

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
          await stats.track(from, sender, hasMedia ? ACTIVITY_TYPES.MEDIA_MESSAGE : ACTIVITY_TYPES.TEXT_MESSAGE, msg.key.id, msg.messageTimestamp)
        }
      }
    }
  })
}

// limpa pedidos expirados a cada minuto
setInterval(async () => {
  try { await pending.purgeExpired() } catch (_) {}
}, 60 * 1000)

monitor.start()

// bootstrap: run migrations then start
init().then(async () => {
  log.info('Migrations aplicadas, a iniciar bot...')
  await contacts.loadLidCache()
  start()
}).catch(err => {
  log.error({ err }, 'Falha ao inicializar base de dados')
  process.exit(1)
})
