const { sql } = require('./db')

// Pedidos de melhoria (!request). O estado e as datas são mudados na UI de
// admin; aqui só se grava e se lista.

const MAX_CHARS = 2000
const STATUS = ['pendente', 'aprovado', 'recusado']

// Corta por code point e não por unidade UTF-16: assim um emoji no limite
// não fica partido ao meio (o VARCHAR do Postgres também conta code points).
function truncar(texto) {
  const cps = Array.from(texto)
  return cps.length > MAX_CHARS ? cps.slice(0, MAX_CHARS).join('') : texto
}

async function criar(groupId, sender, texto) {
  const [row] = await sql`
    INSERT INTO requests (group_id, sender, texto)
    VALUES (${groupId}, ${sender}, ${truncar(texto)})
    RETURNING request_id
  `
  return row.request_id
}

// Os mais recentes primeiro. As datas saem já formatadas: são DATE puras,
// sem fuso, e convertê-las em Date do JS arrisca recuar um dia.
async function listar(groupId, limite = 15) {
  const rows = await sql`
    SELECT request_id, sender, texto, status,
           to_char(inicio_implementacao, 'DD/MM') as inicio,
           to_char(deploy_estimado, 'DD/MM') as deploy,
           COUNT(*) OVER ()::int as total
    FROM requests
    WHERE group_id = ${groupId}
    ORDER BY created_at DESC
    LIMIT ${limite}
  `
  return { pedidos: rows, total: rows[0]?.total || 0 }
}

// Um pedido deste grupo — pedidos de outros grupos não são visíveis daqui.
async function obter(groupId, id) {
  const [row] = await sql`
    SELECT request_id, sender, texto, status,
           to_char(inicio_implementacao, 'DD/MM/YYYY') as inicio,
           to_char(deploy_estimado, 'DD/MM/YYYY') as deploy,
           created_at
    FROM requests
    WHERE group_id = ${groupId} AND request_id = ${id}
  `
  return row || null
}

module.exports = { criar, listar, obter, truncar, MAX_CHARS, STATUS }
