const stats = require('./stats')
const contacts = require('./contacts')
const gemini = require('./gemini')
const football = require('./football')
const settings = require('./settings')

const commands = {
  help: {
    description: 'Lista os comandos disponíveis',
    usage: '/bot help',
    aliases: ['ajuda'],
    handler(groupId, sender, args, alias, parsed) {
      const disabled = settings.getDisabledCommands(groupId)
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
    description: 'Ranking de mensagens do grupo',
    usage: '/bot stats [hoje|semana|mes|dia|periodo]',
    aliases: ['rank', 'ranking' , 'offline'],
    handler(groupId, sender, args) {
      const sub = (args[0] || 'hoje').toLowerCase()
      const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
      const medals = ['🥇', '🥈', '🥉']

      function formatRanking(title, data) {
        const sorted = Object.entries(data).sort((a, b) => b[1] - a[1])
        if (sorted.length === 0) return 'Ainda não há dados suficientes.'
        const lines = [`\`\`\` ${title}`]
        sorted.forEach(([user, count], i) => {
          const name = contacts.getName(user)
          const prefix = medals[i] || `${i + 1}.`
          lines.push(`  ${prefix} ${name} - ${count} msg`)
        })
        lines.push('```')
        return lines.join('\n')
      }

      if (sub === 'hoje') {
        return formatRanking('Ranking de hoje:', stats.getToday(groupId))
      }

      if (sub === 'semana') {
        return formatRanking('Ranking da semana (Dom-Sáb):', stats.getWeek(groupId))
      }

      if (sub === 'mes') {
        return formatRanking('Ranking do mês (30 dias):', stats.getMonth(groupId))
      }

      if (sub === 'dia') {
        const rows = stats.getBusiestDay(groupId)
        if (rows.length === 0) return 'Ainda não há dados suficientes.'
        const lines = ['``` Dias mais ativos (últimos 7 dias):']
        rows.forEach((r) => {
          lines.push(`  ${DAYS[r.day_of_week]} - ${r.total} msg`)
        })
        lines.push('```')
        return lines.join('\n')
      }

      if (sub === 'periodo') {
        const rows = stats.getBusiestPeriod(groupId)
        if (rows.length === 0) return 'Ainda não há dados suficientes.'
        const labels = { manha: 'Manhã (6h-17h59)', noite: 'Noite (18h-05h59)' }
        const lines = ['``` Períodos mais ativos (últimos 7 dias):']
        rows.forEach((r) => {
          lines.push(`  ${labels[r.period]} - ${r.total} msg`)
        })
        lines.push('```')
        return lines.join('\n')
      }

      return 'Uso: /bot stats [hoje|semana|mes|dia|periodo]'
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
        return contacts.getName(`${num}@s.whatsapp.net`)
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
}

// constrói mapa de aliases a partir das definições dos comandos
function buildAliasMap() {
  const map = {}
  for (const [name, cmd] of Object.entries(commands)) {
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        const base = alias.replace(/^[\/!]/, '')
        map[`/${base}`] = `/bot ${name}`
        map[`!${base}`] = `!bot ${name}`
      }
    }
  }
  return map
}

const aliasMap = buildAliasMap()

function parse(text) {
  // resolve alias (longest match first to avoid partial collisions like !fut matching !futebol)
  let resolved = text
  let alias = null
  const sortedAliases = Object.entries(aliasMap).sort((a, b) => b[0].length - a[0].length)
  for (const [a, expansion] of sortedAliases) {
    if (text.toLowerCase().startsWith(a + ' ') || text.toLowerCase() === a) {
      alias = a.replace(/^[\/!]/, '')
      resolved = expansion + text.slice(a.length)
      break
    }
  }

  // remove pontuação colada ao alias (ex: "!leco, texto" -> "!bot ai texto")
  resolved = resolved.replace(/^([\/!]\w+)[,;:]\s*/, '$1 ')

  // suporta aliases do nome do bot (config.botAliases)
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

  if (settings.isTroll(groupId)) {
    const trollResponses = ['𓀐𓂸', 'ूाीू', 'ε⥰']
    return trollResponses[Math.floor(Math.random() * trollResponses.length)]
  }

  const disabled = settings.getDisabledCommands(groupId)

  // comando desabilitado — mostra help
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

function isSlow(text, groupId) {
  const parsed = parse(text)
  if (!parsed) return false
  const cmd = commands[parsed.command]
  if (!cmd || !cmd.slow) return false

  // don't show loading for disabled commands
  if (groupId) {
    const disabled = settings.getDisabledCommands(groupId)
    if (disabled.includes(parsed.command) || (parsed.alias && disabled.includes(parsed.alias))) {
      return false
    }
  }

  return true
}

function isTroll(groupId) {
  return settings.isTroll(groupId)
}

function getCommandList() {
  return Object.entries(commands).map(([name, cmd]) => ({
    name,
    description: cmd.description,
  }))
}

module.exports = { execute, parse, isSlow, isTroll, getCommandList }
