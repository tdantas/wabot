#!/usr/bin/env node
/**
 * Apaga a presença passiva (baldes sem qualquer ação) anterior a hoje.
 *
 *   node bot/prune-observers.js            # mostra o que faria
 *   node bot/prune-observers.js --apply    # apaga
 *
 * Serve para recomeçar a contagem de "só observam" a partir de hoje, sem tocar
 * no histórico de participação: os baldes com `actions > 0` ficam intactos, e
 * com eles o heatmap dos dias anteriores.
 *
 * O corte é a meia-noite de hoje no fuso de cada grupo.
 */
const { sql, close } = require('./db')

const apply = process.argv.includes('--apply')

// meia-noite de hoje no fuso do grupo, como instante
const corte = sql`
  (date_trunc('day', NOW() AT TIME ZONE COALESCE(gs.timezone, 'Europe/Lisbon'))
   AT TIME ZONE COALESCE(gs.timezone, 'Europe/Lisbon'))
`

async function main() {
  const resumo = await sql`
    SELECT COALESCE(c.name, p.group_id) as grupo,
           COUNT(*)::int as baldes,
           MIN(p.bucket)::date as desde,
           MAX(p.bucket)::date as ate
    FROM presence p
    JOIN group_settings gs ON gs.group_id = p.group_id
    LEFT JOIN contacts c ON c.jid = p.group_id
    WHERE p.actions = 0 AND p.bucket < ${corte}
    GROUP BY 1 ORDER BY 2 DESC
  `

  if (resumo.length === 0) {
    console.log('Nada a apagar: não há presença passiva anterior a hoje.')
    return
  }

  console.table(resumo)
  const total = resumo.reduce((a, r) => a + r.baldes, 0)

  if (!apply) {
    console.log(`\n${total} baldes seriam apagados. Corre com --apply para aplicar.`)
    console.log('Os baldes com atividade (actions > 0) não são tocados.')
    return
  }

  const res = await sql`
    DELETE FROM presence p
    USING group_settings gs
    WHERE gs.group_id = p.group_id
      AND p.actions = 0
      AND p.bucket < ${corte}
  `
  console.log(`\n${res.count} baldes apagados.`)
}

main()
  .catch((err) => { console.error('Falhou:', err.message); process.exitCode = 1 })
  .finally(() => close())
