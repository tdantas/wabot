const { v4: uuidv4 } = require('uuid')
const stats = require('./stats')
const contacts = require('./contacts')
const gemini = require('./gemini')
const football = require('./football')
const settings = require('./settings')
const milestone = require('./milestone')
const requests = require('./requests')
const { sql } = require('./db')

const LIVE_DOMAIN = process.env.LIVE_DOMAIN || 'http://localhost:3000'

const MAX_EMOJIS = 3
const _segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('pt', { granularity: 'grapheme' })
  : null

// Mantém no máximo MAX_EMOJIS emojis para o nome não esticar a linha.
// Segmenta por grafema: 👨🏽‍💻 e 🇧🇷 contam como 1, não como vários.
function limitEmojis(str) {
  const graphemes = _segmenter ? [..._segmenter.segment(str)].map(s => s.segment) : [...str]
  let kept = 0
  const out = graphemes
    .filter(g => {
      if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(g)) return true
      return ++kept <= MAX_EMOJIS
    })
    .join('')
  return out.replace(/\s+/g, ' ').trim()
}

// Largura útil do bloco monoespaçado do WhatsApp no telemóvel. Um emoji
// ocupa duas colunas.
const LARGURA_RANK = 30
const MEDALHAS = ['🥇', '🥈', '🥉']
const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])

const ehEmoji = g => /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(g)
const ehPalavra = p => /[\p{L}\p{N}]/u.test(p)

function largura(str) {
  const graphemes = _segmenter ? [..._segmenter.segment(str)].map(s => s.segment) : [...str]
  return graphemes.reduce((n, g) => n + (ehEmoji(g) ? 2 : 1), 0)
}

// comparação de nomes: sem maiúsculas nem acentos (José == jose)
const chaveNome = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

function semEmojis(str) {
  const graphemes = _segmenter ? [..._segmenter.segment(str)].map(s => s.segment) : [...str]
  return graphemes.filter(g => !ehEmoji(g)).join('')
}

// Nome curto do ranking em três níveis de detalhe:
//   0 → Thiago        1 → Thiago D.        2 → Thiago Dantas
// Os emojis do perfil ficam de fora (cada um ocupa duas colunas); só um nome
// feito apenas de emojis os mantém, senão a linha ficava sem nome.
function nomeNivel(fullName, nivel) {
  const raw = String(fullName || '').trim()
  const palavras = semEmojis(raw).split(/\s+/).filter(ehPalavra)
  if (palavras.length === 0) return limitEmojis(raw)
  const nome = [palavras[0]]
  // o sobrenome salta "de"/"da"/"dos": Fabio de Oliveira → Fabio O.
  const sobrenome = palavras.slice(1).find(p => !PARTICULAS.has(p.toLowerCase())) || palavras[1]
  if (sobrenome && nivel === 1) nome.push([...sobrenome].find(ch => /[\p{L}\p{N}]/u.test(ch)) + '.')
  if (sobrenome && nivel >= 2) nome.push(sobrenome)
  return nome.join(' ')
}

// Só o primeiro nome; quando dois nomes da lista coincidem, esses sobem de
// nível até ficarem distintos.
function nomesRanking(fullNames) {
  const niveis = fullNames.map(() => 0)
  for (let nivel = 0; nivel < 2; nivel++) {
    const chave = i => chaveNome(nomeNivel(fullNames[i], niveis[i]).replace(/[^\p{L}\p{N}. ]/gu, '').trim())
    const grupos = new Map()
    fullNames.forEach((_, i) => {
      const k = chave(i)
      grupos.set(k, [...(grupos.get(k) || []), i])
    })
    for (const idx of grupos.values()) {
      if (idx.length > 1) idx.forEach(i => { niveis[i] = nivel + 1 })
    }
  }
  return fullNames.map((n, i) => nomeNivel(n, niveis[i]))
}

// completa `str` até `w` colunas, centrado (emojis contam 2)
function centrar(str, w) {
  const folga = w - largura(str)
  const esq = Math.floor(folga / 2)
  return ' '.repeat(esq) + str + ' '.repeat(folga - esq)
}

// Pódio em ASCII com o nome e as mensagens dos 3 primeiros — 2º à esquerda,
// 1º ao centro, 3º à direita. Devolve null quando algum nome não cabe no
// espaço livre à sua altura; o !rank cai então na lista simples.
//
//           José
//           1190
//         +-------+
// Gustavo |  1º   |
//   913   |       | Eduardo
// +-------+       |   674
// |  2º   |       +-------+
// |       |       |  3º   |
// +-------+-------+-------+
function desenharPodio(top3) {
  if (top3.length < 3) return null
  // sem `total` (ex.: !haters) o pódio leva só os nomes
  const comNumero = top3.every((p) => p.total != null)
  const [p1, p2, p3] = top3.map(({ nome, total }) => ({ nome, total: comNumero ? String(total) : '' }))
  const cabe = (p, max) => largura(p.nome) <= max && p.total.length <= max

  // o 1º tem a linha inteira, centrado sobre o degrau (colunas 8–16)
  if (!cabe(p1, LARGURA_RANK)) return null
  // o 2º fica entre a margem e a parede do degrau do 1º
  if (!cabe(p2, 8)) return null
  // o 3º começa a seguir à parede do 1º (coluna 17) e vai até ao limite
  if (!cabe(p3, LARGURA_RANK - 17)) return null

  const sobre1 = (txt) => {
    const w = largura(txt)
    if (w <= 9) return ' '.repeat(8) + centrar(txt, 9)
    return ' '.repeat(Math.max(0, 12 - Math.floor(w / 2))) + txt
  }
  const sobre3 = (txt) => (largura(txt) <= 9 ? centrar(txt, 9) : txt)

  const meio = comNumero
    ? [
      centrar(p2.total, 8) + '|       |' + sobre3(p3.nome),
      '+-------+       |' + sobre3(p3.total),
    ]
    : ['+-------+       |' + sobre3(p3.nome)]

  return [
    sobre1(p1.nome),
    ...(comNumero ? [sobre1(p1.total)] : []),
    '        +-------+',
    centrar(p2.nome, 8) + '|  1º   |',
    ...meio,
    '|  2º   |       +-------+',
    '|       |       |  3º   |',
    '+-------+-------+-------+',
  ].map((l) => l.trimEnd())
}

// Pódio só com dois lugares: o 1º à esquerda e o 2º à direita, que assim
// tem espaço para um nome comprido (a partir da coluna 9). `total` é
// opcional — sem ele desenha-se só o nome.
//
//  Arthur
// +-------+
// |  1º   | André Coutinho
// |       +-------+
// |       |  2º   |
// +-------+-------+
function desenharPodioDuplo([p1, p2]) {
  const sobre = (p, w) => [p.nome, ...(p.total != null ? [String(p.total)] : [])]
    .map((t) => (largura(t) <= w ? centrar(t, w) : ' ' + t))
  const [nome1, ...num1] = sobre(p1, 9)
  const [nome2, ...num2] = sobre(p2, 9)
  return [
    nome1,
    ...num1,
    '+-------+',
    '|  1º   |' + nome2,
    ...num2.map((n) => '|       |' + n),
    '|       +-------+',
    '|       |  2º   |',
    '+-------+-------+',
  ].map((l) => l.trimEnd())
}

// os haters do !haters kadico: nome mostrado e LID (o `sender` dos events)
// Os haters de cada alvo do !haters: nome mostrado e LIDs (o `sender` dos
// events). Com mais de 3 candidatos, o pódio fica com os 3 que mais falaram.
const HATERS = {
  kadico: [
    { nome: 'Arthur', jids: ['83876600905844@lid'] }, // Artur Costa
    { nome: 'André', jids: ['232417910591564@lid'] }, // André Coutinho
  ],
  titi: [
    { nome: 'Kaleb', jids: ['143031118356658@lid'] }, // Kaleb Araújo
    { nome: 'José', jids: ['31237448151139@lid'] }, // José Bernardo Oliveira
    { nome: 'Marcelo', jids: ['163114351866022@lid'] }, // Marcelo Menezes
    { nome: 'Rafael', jids: ['147532344750268@lid'] }, // Rafael Siqueira
  ],
}

const ESTADO_PEDIDO = { pendente: '⏳ pendente', aprovado: '✅ aprovado', recusado: '❌ recusado' }
const PREVIA_PEDIDO = 80 // caracteres do texto mostrados no !request list

async function listarPedidos(groupId) {
  const { pedidos, total } = await requests.listar(groupId)
  if (pedidos.length === 0) return 'Ainda não há pedidos neste grupo. Faz um com !request <pedido>.'

  const nomes = nomesRanking(await Promise.all(pedidos.map((p) => contacts.getName(p.sender))))
  const blocos = pedidos.map((p, i) => {
    const cps = Array.from(p.texto.replace(/\s+/g, ' '))
    const previa = cps.length > PREVIA_PEDIDO ? cps.slice(0, PREVIA_PEDIDO).join('') + '…' : cps.join('')
    const datas = [p.inicio && `🛠️ início ${p.inicio}`, p.deploy && `🚀 deploy ${p.deploy}`].filter(Boolean)
    return [
      `*#${p.request_id}* ${ESTADO_PEDIDO[p.status] || p.status} — ${nomes[i]}`,
      previa,
      ...(datas.length ? [datas.join(' · ')] : []),
    ].join('\n')
  })

  const mais = total > pedidos.length ? [`_… e mais ${total - pedidos.length} pedidos antigos_`] : []
  return ['*Pedidos do grupo*', ...blocos, ...mais].join('\n\n')
}

async function mostrarPedido(groupId, id) {
  const p = await requests.obter(groupId, id)
  if (!p) return `Não encontrei o pedido #${id} neste grupo.`
  const [nome] = nomesRanking([await contacts.getName(p.sender)])
  const pedidoEm = p.created_at.toLocaleDateString('pt-BR', { timeZone: await settings.getTimezone(groupId) })
  return [
    `*Pedido #${p.request_id}*`,
    `Estado: ${p.status}`,
    `Pedido: ${p.texto}`,
    `Feito por ${nome} em ${pedidoEm}`,
    ...(p.inicio ? [`Início da implementação: ${p.inicio}`] : []),
    ...(p.deploy ? [`Deploy estimado: ${p.deploy}`] : []),
  ].join('\n')
}

// Topo de um período, partilhado pelo !rank e pelo !spy. `rows` traz
// { sender, total } e, no !rank, também `diurnas`. Opções:
//   unidade — palavra a seguir ao número ("msg", "vezes")
//   pct     — mostra a % das mensagens em horário diurno
//   rodape  — linhas de nota no fim do bloco
async function formatTopo(groupId, title, rows, { unidade, pct = false, rodape = [] }) {
  const mapa = {}
  for (const r of rows) mapa[r.sender] = r
  // membros omitidos continuam a ser contabilizados, mas não aparecem
  const visivel = await settings.filterOmitted(groupId, mapa)
  const sorted = Object.values(visivel).sort((a, b) => b.total - a.total).slice(0, 10)
  if (sorted.length === 0) return `\`\`\`${title}\nAinda não há dados suficientes.\n\`\`\``
  const names = nomesRanking(await Promise.all(sorted.map((r) => contacts.getName(r.sender))))
  // sem indentação à esquerda: no telemóvel o bloco monoespaçado tem
  // ~30 colunas e qualquer espaço extra empurra a linha para a seguinte
  const lines = [`\`\`\`${title}`]
  const linhaLista = (r, i) => {
    // % das mensagens em horário de expediente, no fuso do grupo
    const sufixo = pct ? ` (${Math.round((r.diurnas / r.total) * 100)}%)` : ''
    return `${i + 1}. ${names[i]} ${r.total} ${unidade}${sufixo}`
  }

  // pódio desenhado quando os 3 nomes cabem; senão, a lista de sempre
  const podio = desenharPodio(sorted.slice(0, 3).map((r, i) => ({ nome: names[i], total: r.total })))
  if (podio) {
    lines.push('', ...podio)
    if (sorted.length > 3) lines.push('')
    sorted.slice(3).forEach((r, j) => lines.push(linhaLista(r, j + 3)))
  } else {
    sorted.forEach((r, i) => {
      let linha = linhaLista(r, i)
      // medalha no fim do pódio, só se couber sem quebrar a linha
      const medalha = MEDALHAS[i]
      if (medalha && largura(`${linha} ${medalha}`) <= LARGURA_RANK) linha += ` ${medalha}`
      lines.push(linha)
    })
  }
  if (rodape.length) lines.push('', ...rodape)
  lines.push('```')
  return lines.join('\n')
}

// Datas no fuso do grupo. `now` já vem como hora de parede (do toLocaleString),
// por isso formata-se pelos getters locais — voltar a aplicar o fuso deslocava
// a data outra vez, perto da meia-noite.
const pad2 = (n) => String(n).padStart(2, '0')
const ddmm = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`
const ddmmaaaa = (d) => `${ddmm(d)}/${d.getFullYear()}`
const agoraNoGrupo = (TZ) => new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))

// janelas de dias aceites pelo !rank e pelo !spy
const JANELAS_RANK = ['7', '15', '21', '30']

const MESES_TITULO = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

// Traduz os argumentos comuns ao !rank e ao !spy no período e no título.
// Devolve null quando não reconhece — o comando responde com a ajuda.
function periodoPedido(args, TZ, rotulo, janelas) {
  const now = agoraNoGrupo(TZ)

  if (args.length === 1 && /^(dia|hoje)$/i.test(args[0])) {
    // o período vai numa segunda linha para o título não quebrar
    return { opts: { days: 0 }, title: `${rotulo} de hoje\n${ddmmaaaa(now)}` }
  }

  if (args.length === 2 && janelas.includes(args[0]) && /^dias?$/i.test(args[1])) {
    const days = parseInt(args[0], 10)
    const start = new Date(now)
    // o período inclui hoje, então 7 dias começa há 6 dias
    start.setDate(now.getDate() - (days - 1))
    return { opts: { days }, title: `${rotulo} dos últimos ${days} dias\n${ddmm(start)} → ${ddmm(now)}` }
  }

  if (args.length === 1 && /^m[eê]s$/i.test(args[0])) {
    return { opts: { month: true }, title: `${rotulo} de ${MESES_TITULO[now.getMonth()]} ${now.getFullYear()}` }
  }

  if (args.length === 1 && /^\d{4}$/.test(args[0])) {
    const year = parseInt(args[0], 10)
    const anoAtual = now.getFullYear()
    if (year < 2020 || year > anoAtual) return { erro: `Ano inválido. Use um ano entre 2020 e ${anoAtual}.` }
    const fim = year === anoAtual ? ddmm(now) : '31/12'
    return { opts: { year }, title: `${rotulo} de ${year}\n01/01 → ${fim}` }
  }

  return null
}

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
        if (disabled.includes(name) || cmd.hidden) continue
        const usage = cmd.usage.replace(/\/bot/, `${prefix}${botName}`)
        lines.push(`\n*${usage}*\n${cmd.description}`)
      }
      return lines.join('\n')
    },
  },

  stats: {
    description: 'Top 10 de quem mais falou (últimos dias, mês ou ano)',
    usage: '/bot rank [dia | 7|15|21|30 dias | mes | ano]',
    aliases: ['rank', 'ranking' , 'offline'],
    async handler(groupId, sender, args) {
      // fuso de apresentação do grupo, configurável na UI
      const TZ = await settings.getTimezone(groupId)

      // o wa.js não contabiliza comandos, então o !rank conta a si próprio
      // antes de montar a resposta (aparece já no ranking devolvido)
      await stats.track(groupId, sender)

      // !rank sem argumentos equivale a !rank hoje
      if (args.length === 0) args = ['hoje']

      // !rank premios → quem soma mais pontos nos prémios de domingo
      if (args.length === 1 && /^pr[eêé]mios?$/i.test(args[0])) {
        const ano = agoraNoGrupo(TZ).getFullYear()
        return formatTopo(groupId, `Prêmios de ${ano}`, await milestone.pontuacao(groupId, ano), {
          unidade: 'pts',
          rodape: ['BISOU 2 · HAT TRICK 3', 'POKER 4'],
        })
      }

      const periodo = periodoPedido(args, TZ, 'Ranking', JANELAS_RANK)
      if (!periodo) return 'Uso: !rank [dia | [7|15|21|30] dias | mes | <ano> | premios]\n\nExemplos:\n  !rank          — só hoje\n  !rank 7 dias   — últimos 7 dias\n  !rank 21 dias  — últimos 21 dias\n  !rank mes      — mês atual\n  !rank 2026     — o ano inteiro\n  !rank premios  — pontos dos prémios de domingo'
      if (periodo.erro) return periodo.erro

      return formatTopo(groupId, periodo.title, await stats.getRankingDetalhado(groupId, periodo.opts), {
        unidade: 'msg',
        pct: true,
        // rajadas de figurinhas contam uma só vez
        rodape: [`(%) msgs entre ${stats.HORA_INICIO_DIURNO}h e ${stats.HORA_FIM_DIURNO}h`, 'anti-flood ✅'],
      })
    },
  },

  spy: {
    description: 'Top 10 de quem mais acompanhou sem escrever',
    usage: '/bot spy [dia | 7|15|21|30 dias | mes | ano]',
    aliases: ['spy', 'olheiros'],
    async handler(groupId, sender, args) {
      const TZ = await settings.getTimezone(groupId)
      await stats.track(groupId, sender)

      if (args.length === 0) args = ['hoje']

      const periodo = periodoPedido(args, TZ, 'Olheiros', JANELAS_RANK)
      if (!periodo) return 'Uso: !spy [dia | [7|15|21|30] dias | mes | <ano>]\n\nExemplos:\n  !spy           — só hoje\n  !spy 7 dias    — últimos 7 dias\n  !spy 21 dias   — últimos 21 dias\n  !spy mes       — mês atual'
      if (periodo.erro) return periodo.erro

      return formatTopo(groupId, periodo.title, await stats.getObservadores(groupId, periodo.opts), {
        unidade: 'vezes',
        rodape: ['viu o grupo sem escrever'],
      })
    },
  },

  // Brincadeira do grupo: só o Kadico tem haters. Fica fora do !help.
  // A ordem do pódio é quem dos dois mais falou no grupo nos últimos 7 dias.
  haters: {
    description: 'Mostra os haters de alguém',
    usage: '/bot haters <nome>',
    aliases: ['hater'],
    hidden: true,
    async handler(groupId, sender, args) {
      const alvo = args.join(' ').trim()
      if (!alvo) return 'Uso: !haters <nome>'
      const lista = HATERS[alvo.toLowerCase()]
      if (!lista) return `${alvo} não tem haters.`

      // a posição é de quem mais falou no grupo nos últimos 7 dias
      const contagem = {}
      for (const r of await stats.getRankingDetalhado(groupId, { days: 7 })) contagem[r.sender] = r.total
      const ordem = lista
        .map((h) => ({ nome: h.nome, msgs: Math.max(0, ...h.jids.map((j) => contagem[j] || 0)) }))
        // sort estável: no empate fica a ordem da lista
        .sort((a, b) => b.msgs - a.msgs)
        .slice(0, 3)
        .map(({ nome }) => ({ nome }))

      const podio = ordem.length === 2 ? desenharPodioDuplo(ordem) : desenharPodio(ordem)
      const titulo = alvo.charAt(0).toUpperCase() + alvo.slice(1).toLowerCase()
      return [`\`\`\`Haters do ${titulo}`, '', ...podio, '```'].join('\n')
    },
  },

  // Pedidos de melhoria: ficam na BD e o estado é gerido na UI de admin.
  request: {
    description: 'Faz um pedido de melhoria ao bot (!request list mostra os pedidos)',
    usage: '/bot request <pedido> | list | #nº',
    async handler(groupId, sender, args) {
      const texto = args.join(' ').trim()
      if (!texto) return 'Uso: !request <pedido>\n      !request list — ver os pedidos do grupo\n      !request #101 — ver o estado do pedido 101'
      if (/^(list|lista|listar)$/i.test(texto)) return listarPedidos(groupId)
      const consulta = texto.match(/^#\s*(\d{1,9})$/)
      if (consulta) return mostrarPedido(groupId, Number(consulta[1]))

      const id = await requests.criar(groupId, sender, texto)
      const aviso = Array.from(texto).length > requests.MAX_CHARS
        ? `\n_(o texto passou de ${requests.MAX_CHARS} caracteres e foi cortado)_`
        : ''
      return `Pedido *#${id}* registado. O seu pedido está em análise.${aviso}`
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
  // [\\s\\S]* e não .*: um pedido escrito em várias linhas (ex.: !request)
  // não pode falhar o match e ser ignorado em silêncio
  const botRegex = new RegExp(`^[\/!](${botNames})\\s+([\\w\\u00C0-\\u024F]+)[,;:]?\\s*([\\s\\S]*)$`, 'i')

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
