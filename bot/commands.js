const { v4: uuidv4 } = require('uuid')
const stats = require('./stats')
const contacts = require('./contacts')
const gemini = require('./gemini')
const football = require('./football')
const settings = require('./settings')
const { sql } = require('./db')

const LIVE_DOMAIN = process.env.LIVE_DOMAIN || 'http://localhost:3000'

const commands = {
  help: {
    description: 'Lista os comandos disponíveis',
    usage: '/bot help',
    aliases: ['ajuda'],
    async handler(groupId, sender, args, alias, parsed) {
      const disabled = await settings.getDisabledCommands(groupId)
      const botName = parsed?.botName || 'bot'
      const prefix = parsed?.prefix || '/'
      const lines = ['*Comandos disponíveis:*']
      for (const [name, cmd] of Object.entries(commands)) {
        if (disabled.includes(name)) continue
        const usage = cmd.usage.replace(/\/bot/, `${prefix}${botName}`)
        lines.push(`\n*${usage}*\n${cmd.description}`)
      }
      return lines.join('\n')
    },
  },

  stats: {
    description: 'Top 3 do grupo (últimos dias, mês ou ano)',
    usage: '/bot rank [7|15|21 dias | mes | ano]',
    aliases: ['rank', 'ranking' , 'offline'],
    _dailyUsage: new Map(),
    async handler(groupId, sender, args) {
      const TZ = process.env.TZ || 'Europe/Lisbon'
      const medals = ['🥇', '🥈', '🥉']
      const fmt = (d) => d.toLocaleDateString('pt-BR', { timeZone: TZ })

      // rate limit: 2x por dia por pessoa por grupo
      const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
      const key = `${groupId}:${sender}:${today}`
      const usage = commands.stats._dailyUsage
      // limpar entradas de dias anteriores
      for (const k of usage.keys()) {
        if (!k.endsWith(`:${today}`)) usage.delete(k)
      }
      const count = usage.get(key) || 0
      if (count >= 2) {
        const ironias = [
          'Calma, fiscal do ranking. Só 2x por dia. Vai viver a vida que o ranking não muda a cada 5 minutos.',
          'De novo? O ranking não vai mudar só porque estás a olhar para ele. 2x por dia, campeão.',
          'Já gastaste as tuas 2 consultas de hoje. Relaxa, ninguém está a pensar em ti tanto quanto tu achas.',
          'Limite atingido. Dica: se estás tão preocupado com a tua posição, experimenta mandar mais mensagens em vez de ficar a verificar o ranking.',
          'Só 2x por dia, amigo. O ranking não é espelho — não precisa de ser consultado a toda a hora.',
        ]
        return ironias[Math.floor(Math.random() * ironias.length)]
      }

      async function formatTop3(title, data) {
        const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 3)
        if (sorted.length === 0) return `\`\`\` ${title}\n  Ainda não há dados suficientes.\n\`\`\``
        const names = await Promise.all(sorted.map(([user]) => contacts.getName(user)))
        const lines = [`\`\`\` ${title}`]
        sorted.forEach(([, count], i) => {
          lines.push(`  ${medals[i]} ${names[i]} - ${count} msg`)
        })
        lines.push('```')
        return lines.join('\n')
      }

      const usageMsg = 'Uso: !rank [7|15|21] dias | mes | <ano>\n\nExemplos:\n  !rank 7 dias   — últimos 7 dias\n  !rank 15 dias  — últimos 15 dias\n  !rank 21 dias  — últimos 21 dias\n  !rank mes      — mês atual\n  !rank 2026     — top 3 do ano'

      // !rank X dias (7, 15 ou 21)
      if (args.length === 2 && /^(7|15|21)$/.test(args[0]) && args[1].toLowerCase() === 'dias') {
        usage.set(key, count + 1)
        const days = parseInt(args[0], 10)
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))
        const start = new Date(now)
        start.setDate(now.getDate() - days)
        const title = `Ranking dos últimos ${days} dias (${fmt(start)} → ${fmt(now)})`
        return formatTop3(title, await stats.getRanking(groupId, days))
      }

      // !rank mes → mês corrente
      if (args.length === 1 && /^m[eê]s$/i.test(args[0])) {
        usage.set(key, count + 1)
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))
        const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
        const title = `Ranking de ${monthNames[now.getMonth()]} ${now.getFullYear()}`
        return formatTop3(title, await stats.getMonth(groupId))
      }

      // !rank <ano>
      if (args.length === 1 && /^\d{4}$/.test(args[0])) {
        usage.set(key, count + 1)
        const year = parseInt(args[0], 10)
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))
        const currentYear = now.getFullYear()
        if (year < 2020 || year > currentYear) {
          return `Ano inválido. Use um ano entre 2020 e ${currentYear}.`
        }
        const start = new Date(`${year}-01-01T00:00:00`)
        const end = year === currentYear ? now : new Date(`${year}-12-31T00:00:00`)
        const title = `Ranking de ${year} (${fmt(start)} → ${fmt(end)})`
        return formatTop3(title, await stats.getYear(groupId, year))
      }

      return usageMsg
    },
  },

  ai: {
    description: 'Pergunta algo à IA',
    usage: '/bot ai <pergunta>',
    aliases: ['ai', 'ruru', "lunga", "tata", "ia"],
    async handler(groupId, sender, args, alias) {
      if (args.length === 0) return 'Uso: /bot ai <pergunta>'
      const prompt = args.join(' ')
      try {
        const reply = await gemini.ask(prompt, 'ai', alias)
        return String(reply).trim() || 'Não consegui encontrar uma resposta. Tenta reformular a pergunta.'
      } catch (err) {
        require('./logger').error({ err }, 'Erro Gemini')
        return 'Ocorreu um erro. Tente novamente.'
      }
    },
  },

  parabens: {
    description: 'Mensagem de parabéns para alguém',
    usage: '/bot parabéns <nome do aniversariante>',
    aliases: ['parabens', 'felizaniversario', 'parabéns'],
    async handler(groupId, sender, args, alias) {
      if (args.length === 0) return 'Uso: /bot parabens @pessoa'
      const raw = args.join(' ')
      const name = raw.replace(/@(\d+)/g, (_, num) => {
        return num
      }).replace(/@/g, '')
      try {
        const reply = await gemini.ask(`Cria uma mensagem de parabéns de aniversário para ${name}`, 'parabens', alias)
        return String(reply).trim() || `Parabéns ${name}! Muita saúde e felicidade!`
      } catch (err) {
        require('./logger').error({ err }, 'Erro Gemini parabens')
        return 'Ocorreu um erro. Tente novamente.'
      }
    },
  },

  versiculo: {
    description: 'Envia um versículo bíblico',
    usage: '/bot versículo [tema]',
    aliases: ['biblia', 'verso', 'versiculo', 'versículo'],
    slow: true,
    async handler(groupId, sender, args) {
      const tema = args.length > 0 ? args.join(' ') : null
      const prompt = tema
        ? `Pesquisa um versículo bíblico sobre "${tema}". Retorna o versículo com a referência (livro, capítulo e versículo).`
        : 'Pesquisa um versículo bíblico aleatório e inspirador. Retorna o versículo com a referência (livro, capítulo e versículo).'
      try {
        const reply = await gemini.ask(prompt, 'versiculo')
        return String(reply).trim() || 'Não encontrei um versículo. Tenta novamente.'
      } catch (err) {
        require('./logger').error({ err }, 'Erro Gemini')
        return 'Ocorreu um erro. Tente novamente.'
      }
    },
  },

  profile: {
    description: 'Perfil dos malucos do grupo',
    usage: '/bot profile',
    aliases: ['perfil'],
    slow: true,
    async handler(groupId, sender, args, alias) {
      try {
        const reply = await gemini.ask('', 'profile', alias)
        return String(reply).trim() || 'Não consegui gerar o perfil. Tenta novamente.'
      } catch (err) {
        require('./logger').error({ err }, 'Erro Gemini profile')
        return 'Ocorreu um erro. Tente novamente.'
      }
    },
  },

  news: {
    description: 'Notícias recentes sobre um tema',
    usage: '/bot news <tema>',
    aliases: ['news', 'noticias', 'notícias', 'noticia', 'notícia'],
    slow: true,
    signed: true,
    async handler(groupId, sender, args, alias) {
      if (args.length === 0) return 'Uso: /bot news <tema>'
      const prompt = args.join(' ')
      try {
        const reply = await gemini.ask(prompt, 'news', alias, {
          searchOptions: {
            timeRangeFilter: {
              startTime: new Date(Date.now() - 4 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
              endTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            },
          },
        })
        return String(reply).trim() || 'Não encontrei notícias recentes sobre esse tema.'
      } catch (err) {
        require('./logger').error({ err }, 'Erro Gemini news')
        return 'Ocorreu um erro. Tente novamente.'
      }
    },
  },

  weather: {
    description: 'Previsão meteorológica para os próximos dias',
    usage: '/bot weather <cidade>',
    aliases: ['weather', 'tempo', 'meteo', 'clima'],
    slow: true,
    async handler(groupId, sender, args, alias) {
      if (args.length === 0) return 'Uso: /bot weather <cidade>'
      const city = args.join(' ')
      try {
        const reply = await gemini.ask(
          `Previsão meteorológica para ${city}`,
          'weather',
          alias
        )
        return String(reply).trim() || 'Não consegui obter a previsão. Tenta novamente.'
      } catch (err) {
        require('./logger').error({ err }, 'Erro Gemini weather')
        return 'Ocorreu um erro. Tente novamente.'
      }
    },
  },

  fut: {
    description: 'Informações de futebol em tempo real',
    usage: '/bot fut <pergunta>',
    aliases: ['fut', 'futebol', 'football', 'golo', 'bola'],
    slow: true,
    signed: true,
    async handler(groupId, sender, args) {
      if (args.length === 0) return 'Uso: /bot fut <pergunta>\nEx: !fut jogos do Benfica hoje'
      const question = args.join(' ')
      try {
        const reply = await football.ask(question)
        return reply || 'Não encontrei dados sobre isso. Tenta reformular.'
      } catch (err) {
        require('./logger').error({ err }, 'Erro football')
        return 'Ocorreu um erro ao consultar dados de futebol.'
      }
    },
  },

  live: {
    description: 'Gera link para ver ranking e gráficos do grupo',
    usage: '/bot live',
    aliases: ['live', 'aovivo', 'online', 'zaprats'],
    async handler(groupId, sender, args) {
      const token = uuidv4()
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

      // invalidate previous tokens for this group
      await sql`DELETE FROM live_tokens WHERE group_id = ${groupId}`

      await sql`
        INSERT INTO live_tokens (token, group_id, created_by, expires_at)
        VALUES (${token}, ${groupId}, ${sender}, ${expiresAt})
      `

      const link = `${LIVE_DOMAIN}/auth/${token}`
      return {
        privateMessage: `Aqui está o seu link para o Group Usage Report:\n\n${link}\n\n⏳ Válido por 24 horas`,
        groupReply: 'Link enviado no privado.',
      }
    },
  },

  food: {
    description: 'Sugere restaurantes perto de ti',
    usage: '/bot food <tipo de restaurante>',
    aliases: ['food', 'rango', 'comida'],
    signed: true,
    handler(groupId, sender, args) {
      if (args.length === 0) return 'Uso: /bot food <tipo de restaurante>'
      return { pendingLocation: true, query: args.join(' ') }
    },
  },

  transcript: {
    description: 'Transcreve áudio para texto',
    usage: '/bot transcript (responda a um áudio)',
    aliases: ['transcript', 'transcricao'],
    slow: true,
    handler() { return null },
  },

  resumo: {
    description: 'Resume um artigo a partir de um link',
    usage: '/bot resumo <link>',
    aliases: ['resumo', 'resumir'],
    slow: true,
    premium: true,
    handler() { return null },
  },
}

// constrói mapa de aliases a partir das definições dos comandos
function buildAliasMap() {
  const map = {}
  for (const [name, cmd] of Object.entries(commands)) {
    const names = new Set([name, ...(cmd.aliases || [])])
    for (const alias of names) {
      const base = alias.replace(/^[\/!]/, '')
      map[`/${base}`] = `/bot ${name}`
      map[`!${base}`] = `!bot ${name}`
    }
  }
  return map
}

const aliasMap = buildAliasMap()

function parse(text) {
  // normalize punctuation after command/alias (e.g. "!ai, pergunta" -> "!ai pergunta")
  let normalized = text.replace(/^([\/!][\w\u00C0-\u024F]+)[,;:]\s*/, '$1 ')

  let resolved = normalized
  let alias = null
  const sortedAliases = Object.entries(aliasMap).sort((a, b) => b[0].length - a[0].length)
  for (const [a, expansion] of sortedAliases) {
    if (normalized.toLowerCase().startsWith(a + ' ') || normalized.toLowerCase() === a) {
      alias = a.replace(/^[\/!]/, '')
      resolved = expansion + normalized.slice(a.length)
      break
    }
  }

  const config = loadConfig()
  const botNames = (config.botAliases || ['bot']).join('|')
  const botRegex = new RegExp(`^[\/!](${botNames})\\s+([\\w\\u00C0-\\u024F]+)[,;:]?\\s*(.*)$`, 'i')

  const match = resolved.match(botRegex)
  if (!match) return null
  const prefix = resolved[0]
  const botName = match[1]
  const command = match[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const args = match[3].trim() ? match[3].trim().split(/\s+/) : []
  return { command, args, alias, prefix, botName }
}

function loadConfig() {
  const fs = require('fs')
  const path = require('path')
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'))
}

async function execute(groupId, sender, text) {
  const parsed = parse(text)
  if (!parsed) return null

  if (await settings.isTroll(groupId)) {
    const trollResponses = ['𓀐𓂸', 'ูาีู', 'ε⥰']
    return trollResponses[Math.floor(Math.random() * trollResponses.length)]
  }

  const disabled = await settings.getDisabledCommands(groupId)

  if (disabled.includes(parsed.command) || (parsed.alias && disabled.includes(parsed.alias))) {
    return commands.help.handler(groupId, sender, [])
  }

  const cmd = commands[parsed.command]
  if (!cmd) return commands.help.handler(groupId, sender, [], null, parsed)

  const result = await cmd.handler(groupId, sender, parsed.args, parsed.alias, parsed)

  if (result && typeof result === 'string') {
    const signature = cmd.signed ? '\n\n_powered by Okivia Group_' : ''
    return `${result}${signature}`
  }

  return result
}

async function isSlow(text, groupId) {
  const parsed = parse(text)
  if (!parsed) return false
  const cmd = commands[parsed.command]
  if (!cmd || !cmd.slow) return false

  if (groupId) {
    const disabled = await settings.getDisabledCommands(groupId)
    if (disabled.includes(parsed.command) || (parsed.alias && disabled.includes(parsed.alias))) {
      return false
    }
  }

  return true
}

async function isTroll(groupId) {
  return settings.isTroll(groupId)
}

function getCommandList() {
  return Object.entries(commands).map(([name, cmd]) => ({
    name,
    description: cmd.description,
  }))
}

module.exports = { execute, parse, isSlow, isTroll, getCommandList }
