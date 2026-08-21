#!/usr/bin/env node
/**
 * Backfill da tabela `presence` a partir do histórico de `events`.
 *
 *   node bot/backfill-presence.js                          # tudo, todos os grupos
 *   node bot/backfill-presence.js --from=2026-01-01
 *   node bot/backfill-presence.js --group=123@g.us --dry-run
 *
 * Cada balde de 5 minutos com atividade vira uma linha, com `events` igual ao
 * número de ações desse balde — a mesma contagem que a captura ao vivo faz para
 * escrita, reação e edição.
 *
 * O que o histórico NÃO consegue reconstruir: o sinal de "online" (grupo aberto
 * ou a escrever). Esse não deixa rasto na tabela `events`, por isso o passado
 * mostra apenas quem participou, nunca quem só leu.
 */
const { sql, close } = require('./db')

const BUCKET_SEG = 300 // 5 minutos, alinhado ao epoch como no presence.js

function arg(nome, omissao = null) {
  const m = process.argv.find((a) => a.startsWith(`--${nome}=`))
  return m ? m.split('=').slice(1).join('=') : omissao
}
const temFlag = (nome) => process.argv.includes(`--${nome}`)

async function main() {
  const grupo = arg('group')
  const dryRun = temFlag('dry-run')

  const [limites] = await sql`
    SELECT MIN(created_at) as inicio, MAX(created_at) as fim FROM events
    ${grupo ? sql`WHERE group_id = ${grupo}` : sql``}
  `
  if (!limites?.inicio) {
    console.log('Não há eventos para processar.')
    return
  }

  const de = new Date(arg('from') || limites.inicio)
  const ate = new Date(arg('to') || limites.fim)
  console.log(`Período: ${de.toISOString().slice(0, 10)} → ${ate.toISOString().slice(0, 10)}`)
  console.log(grupo ? `Grupo: ${grupo}` : 'Todos os grupos')
  if (dryRun) console.log('MODO DRY-RUN — nada será gravado\n')

  let totalBaldes = 0
  let totalEventos = 0

  // mês a mês: mantém as transações curtas e dá progresso visível
  const cursor = new Date(Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1))
  while (cursor <= ate) {
    const fimMes = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    const rotulo = cursor.toISOString().slice(0, 7)

    const baldes = sql`
      SELECT group_id, sender,
             to_timestamp(floor(extract(epoch from created_at) / ${BUCKET_SEG}) * ${BUCKET_SEG}) as bucket,
             COUNT(*)::int as events
      FROM events
      WHERE created_at >= ${cursor} AND created_at < ${fimMes}
        ${grupo ? sql`AND group_id = ${grupo}` : sql``}
      GROUP BY group_id, sender, 3
    `

    if (dryRun) {
      const [{ n, e }] = await sql`
        SELECT COUNT(*)::int as n, COALESCE(SUM(events), 0)::int as e FROM (${baldes}) t
      `
      console.log(`${rotulo}: ${n} baldes, ${e} eventos`)
      totalBaldes += n
      totalEventos += e
    } else {
      // GREATEST evita duplicar contagens em baldes que a captura ao vivo já
      // gravou: fica sempre o maior dos dois, nunca a soma
      const res = await sql`
        INSERT INTO presence (group_id, sender, bucket, events, actions, passive)
        SELECT group_id, sender, bucket, events, events, 0 FROM (${baldes}) t
        ON CONFLICT (group_id, sender, bucket)
        DO UPDATE SET events = GREATEST(presence.events, EXCLUDED.events),
                      actions = GREATEST(presence.actions, EXCLUDED.actions)
      `
      console.log(`${rotulo}: ${res.count} baldes`)
      totalBaldes += res.count
    }

    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  console.log(`\nTotal: ${totalBaldes} baldes${dryRun ? `, ${totalEventos} eventos` : ' gravados'}`)
}

main()
  .catch((err) => { console.error('Falhou:', err.message); process.exitCode = 1 })
  .finally(() => close())
