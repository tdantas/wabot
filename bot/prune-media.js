#!/usr/bin/env node
/**
 * Remove uma fração das MEDIA_MESSAGE de uma pessoa em dias específicos.
 * Pensado para episódios de flood (sequências de stickers) que distorcem o
 * ranking sem representarem participação real.
 *
 *   node bot/prune-media.js --name="Marcio" --days=2026-08-31 --anti-flood
 *   node bot/prune-media.js --name="Marcio" --days=2026-08-31 --anti-flood=86400
 *   node bot/prune-media.js --name="Marcio" --days=2026-08-21,2026-08-22 --apply
 *
 * Dois modos:
 *   --anti-flood[=segundos]  aplica ao passado a mesma regra que o bot usa ao
 *                            vivo: de cada rajada fica só a primeira média.
 *                            A janela é de 60s por omissão; com 86400 (um dia)
 *                            sobra literalmente uma por dia.
 *   (sem a flag)             remove uma fração fixa (metade, por omissão),
 *                            uma sim uma não por ordem cronológica.
 *
 * Por omissão só mostra o que faria. Só apaga com --apply.
 */
const { sql, close } = require('./db')

function arg(nome, omissao = null) {
  const m = process.argv.find((a) => a.startsWith(`--${nome}=`))
  return m ? m.split('=').slice(1).join('=') : omissao
}
const temFlag = (n) => process.argv.includes(`--${n}`)

async function main() {
  const nome = arg('name')
  const dias = (arg('days') || '').split(',').filter(Boolean)
  const grupo = arg('group')
  const fracao = parseInt(arg('keep-every', '2'), 10) // 2 = remove metade
  const apply = temFlag('apply')
  // --anti-flood ou --anti-flood=SEGUNDOS
  const antiFloodArg = process.argv.find((a) => a.startsWith('--anti-flood'))
  const janelaSeg = antiFloodArg
    ? parseInt(antiFloodArg.split('=')[1] || '60', 10)
    : null

  if (!nome || dias.length === 0) {
    console.error('Uso: --name="Nome" --days=2026-08-21,2026-08-22 [--group=...] [--apply]')
    process.exitCode = 1
    return
  }

  const [pessoa] = await sql`SELECT jid, name FROM contacts WHERE name LIKE ${nome + '%'} LIMIT 1`
  if (!pessoa) {
    console.error(`Ninguém encontrado com o nome "${nome}"`)
    process.exitCode = 1
    return
  }
  console.log(`Pessoa: ${pessoa.name} (${pessoa.jid})`)
  console.log(`Dias  : ${dias.join(', ')}${grupo ? `\nGrupo : ${grupo}` : ' (todos os grupos)'}`)
  console.log(apply ? '\nMODO APPLY — vai apagar\n' : '\nDRY-RUN — nada será apagado\n')

  // média da pessoa nos dias pedidos, com o dia no fuso de cada grupo
  const base = sql`
    SELECT e.event_id, e.group_id, e.created_at,
           (e.created_at AT TIME ZONE COALESCE(gs.timezone, 'Europe/Lisbon'))::date as dia
    FROM events e
    LEFT JOIN group_settings gs ON gs.group_id = e.group_id
    WHERE e.sender = ${pessoa.jid}
      AND e.activity_type = 'MEDIA_MESSAGE'
      AND (e.created_at AT TIME ZONE COALESCE(gs.timezone, 'Europe/Lisbon'))::date = ANY(${dias}::date[])
      ${grupo ? sql`AND e.group_id = ${grupo}` : sql``}
  `

  // `rn` = posição dentro da rajada (anti-flood) ou dentro do dia (fração)
  const alvo = janelaSeg
    ? sql`
      SELECT event_id, group_id, dia,
             row_number() OVER (PARTITION BY group_id, dia, rajada ORDER BY created_at) as rn
      FROM (
        SELECT event_id, group_id, dia, created_at,
               SUM(inicio) OVER (PARTITION BY group_id, dia ORDER BY created_at) as rajada
        FROM (
          SELECT event_id, group_id, dia, created_at,
                 CASE WHEN created_at - LAG(created_at) OVER (PARTITION BY group_id, dia ORDER BY created_at)
                           < make_interval(secs => ${janelaSeg})
                      THEN 0 ELSE 1 END as inicio
          FROM (${base}) b
        ) t1
      ) t2
    `
    : sql`
      SELECT event_id, group_id, dia,
             row_number() OVER (PARTITION BY group_id, dia ORDER BY created_at) as rn
      FROM (${base}) b
    `

  // no anti-flood fica a primeira de cada rajada; na fração, uma em cada N
  const condicao = janelaSeg ? sql`t.rn > 1` : sql`t.rn % ${fracao} = 0`

  console.log(janelaSeg
    ? `Modo: anti-flood, janela de ${janelaSeg}s (fica a 1ª de cada rajada)`
    : `Modo: fração — remove 1 em cada ${fracao}`)

  const resumo = await sql`
    SELECT c.name as grupo, t.dia,
           COUNT(*)::int as media_total,
           COUNT(*) FILTER (WHERE ${condicao})::int as a_remover
    FROM (${alvo}) t
    LEFT JOIN contacts c ON c.jid = t.group_id
    GROUP BY 1, 2 ORDER BY 2, 1
  `

  if (resumo.length === 0) {
    console.log('Nada a fazer: não há MEDIA_MESSAGE nesses dias.')
    return
  }
  console.table(resumo)
  const total = resumo.reduce((a, r) => a + r.a_remover, 0)

  if (!apply) {
    console.log(`\n${total} linhas seriam removidas. Corre outra vez com --apply para aplicar.`)
    return
  }

  const res = await sql`
    DELETE FROM events
    WHERE event_id IN (SELECT event_id FROM (${alvo}) t WHERE ${condicao})
  `
  console.log(`\n${res.count} linhas removidas.`)
}

main()
  .catch((err) => { console.error('Falhou:', err.message); process.exitCode = 1 })
  .finally(() => close())
