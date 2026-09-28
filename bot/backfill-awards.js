#!/usr/bin/env node
/**
 * Preenche os prémios semanais (BISOU / HAT TRICK / POKER) dos domingos que já
 * passaram, a partir do histórico de mensagens. Usa exatamente a mesma regra do
 * apuramento ao vivo (milestone.apurarSemana), por isso o resultado é o mesmo
 * que teria saído nesse domingo.
 *
 *   node bot/backfill-awards.js                      # simula, todos os grupos
 *   node bot/backfill-awards.js --group="TNB"        # simula, só um grupo
 *   node bot/backfill-awards.js --since=2026-01-01   # a partir de uma data
 *   node bot/backfill-awards.js --apply              # grava
 *
 * Não envia mensagens ao grupo: só grava o histórico, que é o que alimenta o
 * !rank premios. Domingos já gravados ficam como estão — os índices únicos da
 * tabela impedem duplicados, portanto correr duas vezes é seguro.
 */
const { sql, close } = require('./db')
const settings = require('./settings')
const milestone = require('./milestone')
const contacts = require('./contacts')

function arg(nome, omissao = null) {
  const m = process.argv.find((a) => a.startsWith(`--${nome}=`))
  return m ? m.split('=').slice(1).join('=') : omissao
}

const DIA_MS = 24 * 60 * 60 * 1000
const iso = (d) => d.toISOString().slice(0, 10)

// Os domingos entre duas datas (inclusive), como 'AAAA-MM-DD'. As datas são
// tratadas como dias de calendário em UTC: não há fusos pelo meio, é só
// aritmética de dias.
function domingos(de, ate) {
  const out = []
  const d = new Date(`${de}T00:00:00Z`)
  const fim = new Date(`${ate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7)) // salta para o 1º domingo
  for (; d <= fim; d.setUTCDate(d.getUTCDate() + 7)) out.push(iso(d))
  return out
}

async function main() {
  const grupoArg = arg('group')
  const since = arg('since')
  const apply = process.argv.includes('--apply')

  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('--since tem de ser AAAA-MM-DD')
    process.exitCode = 1
    return
  }

  let grupos = await settings.getMilestoneGroupIds()
  if (grupoArg) {
    const candidatos = await sql`
      SELECT jid, name FROM contacts
      WHERE type = 'group' AND (jid = ${grupoArg} OR name ILIKE ${'%' + grupoArg + '%'})
      ORDER BY name
    `
    // um jid ou um nome exato resolvem a ambiguidade; senão mostra a lista
    const escolhido = candidatos.length === 1
      ? candidatos[0]
      : candidatos.find((c) => c.jid === grupoArg || c.name?.toLowerCase() === grupoArg.toLowerCase())
    if (!escolhido) {
      if (candidatos.length === 0) {
        console.error(`Nenhum grupo encontrado para "${grupoArg}".`)
      } else {
        console.error(`"${grupoArg}" é ambíguo — ${candidatos.length} grupos. Repete com o jid (ou o nome exato):`)
        console.table(candidatos)
      }
      process.exitCode = 1
      return
    }
    grupos = grupos.filter((g) => g === escolhido.jid)
    if (grupos.length === 0) {
      console.error('Esse grupo não tem os marcos ativos, logo não recebe prémios.')
      process.exitCode = 1
      return
    }
  }

  console.log(apply ? 'MODO APPLY — vai gravar\n' : 'DRY-RUN — nada será gravado\n')

  let gravados = 0
  for (const groupId of grupos) {
    const tz = await settings.getTimezone(groupId)
    const nomeGrupo = await contacts.getName(groupId)

    // o primeiro e o último dia com mensagens, já no fuso do grupo
    const [limites] = await sql`
      SELECT MIN((created_at AT TIME ZONE ${tz})::date)::text as primeiro,
             MAX((created_at AT TIME ZONE ${tz})::date)::text as ultimo
      FROM events WHERE group_id = ${groupId}
    `
    if (!limites?.primeiro) {
      console.log(`${nomeGrupo}: sem mensagens, nada a fazer.`)
      continue
    }

    // hoje fica de fora: o domingo corrente é do apuramento ao vivo, às 11h
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: tz })
    const de = since && since > limites.primeiro ? since : limites.primeiro
    const ate = iso(new Date(new Date(`${hoje}T00:00:00Z`).getTime() - DIA_MS))

    const lista = domingos(de, ate)
    console.log(`${nomeGrupo} (${tz}) — ${lista.length} domingos entre ${de} e ${ate}`)

    const linhas = []
    for (const data of lista) {
      const vencedor = await milestone.apurarSemana(groupId, data)
      if (!vencedor) continue
      const { def, sender } = vencedor
      const nome = await contacts.getName(sender)

      let estado = 'a gravar'
      if (apply) {
        const novo = await milestone.gravarSemana(groupId, def, sender, data, tz)
        estado = novo ? 'gravado' : 'já existia'
        if (novo) gravados++
      }
      linhas.push({ domingo: data, premio: def.label, pontos: def.pontos, quem: nome, estado })
    }

    if (linhas.length === 0) console.log('  nenhum prémio: ninguém liderou todas as janelas.\n')
    else { console.table(linhas); console.log() }
  }

  console.log(apply
    ? `${gravados} prémios gravados.`
    : 'Nada foi gravado. Corre outra vez com --apply para aplicar.')
}

main()
  .catch((err) => { console.error('Falhou:', err.message); process.exitCode = 1 })
  .finally(() => close())
