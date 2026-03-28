// JSON response schemas por comando (Gemini structured output)
const schemas = {
  versiculo: {
    type: 'object',
    properties: {
      versiculo: { type: 'string', description: 'O texto do versículo bíblico' },
      referencia: { type: 'string', description: 'Referência bíblica (livro, capítulo e versículo)' },
      explicacao: { type: 'string', description: 'Breve explicação de 2 frases sobre o significado' },
    },
    required: ['versiculo', 'referencia', 'explicacao'],
  },

  food: {
    type: 'object',
    properties: {
      resultados: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'Nome do restaurante' },
            distancia: { type: 'string', description: 'Distância do utilizador (ex: 800m, 1.2km)' },
            avaliacao: { type: 'string', description: 'Avaliação (ex: 4.7 estrelas)' },
            morada: { type: 'string', description: 'Morada completa' },
          },
          required: ['nome', 'distancia', 'avaliacao', 'morada'],
        },
      },
    },
    required: ['resultados'],
  },
}

// formata o JSON parsed para texto legível no WhatsApp
const formatters = {
  versiculo(data) {
    const lines = []
    lines.push(`"${data.versiculo}"`)
    lines.push('')
    lines.push(data.referencia)
    lines.push('')
    lines.push(data.explicacao)
    return lines.join('\n')
  },

  food(data) {
    if (!data.resultados || data.resultados.length === 0) {
      return null
    }
    const lines = []
    data.resultados.forEach((r, i) => {
      if (i > 0) lines.push('')
      lines.push(`*${r.nome}*`)
      lines.push(`${r.distancia} - ${r.avaliacao}`)
      lines.push(r.morada)
    })
    return lines.join('\n')
  },
}

function getSchema(command) {
  return schemas[command] || null
}

function format(command, jsonData) {
  const formatter = formatters[command]
  if (!formatter) return null
  return formatter(jsonData)
}

module.exports = { getSchema, format }
