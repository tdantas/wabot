#!/usr/bin/env node
/**
 * Reduz em X% o "só observam" de uma pessoa: apaga essa fração dos baldes de
 * presença passiva dela (actions = 0), espalhada ao longo do tempo para o
 * heatmap manter a forma.
 *
 *   node bot/reduce-observers.js --name="Marcio" --percent=50
 *   node bot/reduce-observers.js --name="Marcio" --group="TNB" --percent=30 --apply
 *   node bot/reduce-observers.js --jid=5581999999999@s.whatsapp.net --percent=50 --days=2026-09-10,2026-09-11
 *
 *   --name / --jid   a pessoa (o nome procura em qualquer parte, sem maiúsculas)
 *   --group          jid do grupo ou parte do nome; sem ele, todos os grupos
 *   --percent        fração a apagar, de 1 a 100
 *   --days           só estes dias (no fuso de cada grupo); sem ele, todo o histórico
 *   --apply          apaga de facto; sem ele só mostra o que faria
 *
 * Os baldes com participação (actions > 0) e os `events` nunca são tocados.
 * Correr duas vezes reduz duas vezes: 50% e depois 50% deixa 25% do original.
 */
const { sql, close } = require('./db')

function arg(nome, omissao = null) {
  const m = process.argv.find((a) => a.startsWith(`--${nome}=`))
  return m ? m.split('=').slice(1).join('=') : omissao
}

// Resolve um contacto por jid exato ou parte do nome. Mais de um candidato é
// erro: apagar da pessoa errada não tem volta.
async function resolver(tipo, valor, grupos) {
  const rows = await sql`
    SELECT jid, name FROM contacts
    WHERE type = ${grupos ? 'group' : 'person'}
      AND (jid = ${valor} OR name ILIKE ${'%' + valor + '%'})
    ORDER BY name
  `
  if (rows.length === 1) return rows[0]
  const exato = rows.find((r) => r.jid === valor)
  if (exato) return exato
  if (rows.length === 0) {
    console.error(`Nenhum ${tipo} encontrado para "${valor}".`)
  } else {
    console.error(`"${valor}" é ambíguo — ${rows.length} ${tipo}s. Usa um nome mais completo ou o jid:`)
    console.table(rows)
  }
  process.exitCode = 1
  return null
}

async function main() {
  const quem = arg('jid') || arg('name')
  const grupoArg = arg('group')
  const pct = Number(arg('percent'))
  const dias = (arg('days') || '').split(',').filter(Boolean)
  const apply = process.argv.includes('--apply')

  if (!quem || !(pct > 0 && pct <= 100)) {
    console.error('Uso: --name="Nome" | --jid=... --percent=1..100 [--group=...] [--days=AAAA-MM-DD,...] [--apply]')
    process.exitCode = 1
    return
  }

  const pessoa = await resolver('pessoa', quem, false)
  if (!pessoa) return
  const grupo = grupoArg ? await resolver('grupo', grupoArg, true) : null
  if (grupoArg && !grupo) return

  console.log(`Pessoa : ${pessoa.name} (${pessoa.jid})`)
  console.log(`Grupo  : ${grupo ? `${grupo.name} (${grupo.jid})` : 'todos'}`)
  console.log(`Dias   : ${dias.length ? dias.join(', ') : 'todo o histórico'}`)
  console.log(`Reduzir: ${pct}%`)
  console.log(apply ? '\nMODO APPLY — vai apagar\n' : '\nDRY-RUN — nada será apagado\n')

  // Baldes passivos da pessoa, numerados por ordem cronológica em cada grupo.
  // Um balde sai quando floor(rn·p) avança em relação ao anterior: dá
  // exatamente floor(total·p) apagados, distribuídos por igual no tempo.
  const tz = sql`COALESCE(gs.timezone, 'Europe/Lisbon')`
  const alvo = sql`
    SELECT group_id, sender, bucket,
           FLOOR(rn * ${pct}::numeric / 100) > FLOOR((rn - 1) * ${pct}::numeric / 100) as apagar
    FROM (
      SELECT p.group_id, p.sender, p.bucket,
             row_number() OVER (PARTITION BY p.group_id ORDER BY p.bucket) as rn
      FROM presence p
      LEFT JOIN group_settings gs ON gs.group_id = p.group_id
      WHERE p.sender = ${pessoa.jid}
        AND p.actions = 0
        ${grupo ? sql`AND p.group_id = ${grupo.jid}` : sql``}
        ${dias.length ? sql`AND (p.bucket AT TIME ZONE ${tz})::date = ANY(${dias}::date[])` : sql``}
    ) t
  `

  const resumo = await sql`
    SELECT COALESCE(c.name, a.group_id) as grupo,
           COUNT(*)::int as observou,
           COUNT(*) FILTER (WHERE a.apagar)::int as a_apagar,
           (COUNT(*) - COUNT(*) FILTER (WHERE a.apagar))::int as fica
    FROM (${alvo}) a
    LEFT JOIN contacts c ON c.jid = a.group_id
    GROUP BY 1 ORDER BY 2 DESC
  `

  if (resumo.length === 0) {
    console.log('Nada a fazer: esta pessoa não tem presença passiva no filtro pedido.')
    return
  }
  console.table(resumo)
  const total = resumo.reduce((a, r) => a + r.a_apagar, 0)

  if (!apply) {
    console.log(`\n${total} baldes seriam apagados. Corre outra vez com --apply para aplicar.`)
    return
  }

  const res = await sql`
    DELETE FROM presence p
    USING (${alvo}) a
    WHERE a.apagar
      AND p.group_id = a.group_id
      AND p.sender = a.sender
      AND p.bucket = a.bucket
  `
  console.log(`\n${res.count} baldes apagados.`)
}

main()
  .catch((err) => { console.error('Falhou:', err.message); process.exitCode = 1 })
  .finally(() => close())
