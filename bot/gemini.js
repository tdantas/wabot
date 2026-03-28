const { GoogleGenAI } = require('@google/genai')
const fs = require('fs')
const path = require('path')
const { getSchema, format } = require('./schemas')
const log = require('./logger')

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const PROMPTS_DIR = path.join(__dirname, 'prompts')
const VERBOSE = process.env.VERBOSE === 'true'
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

function loadPrompt(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return ''
  }
}

function buildSystemPrompt(command, alias) {
  const parts = [
    loadPrompt(path.join(PROMPTS_DIR, 'RULES.md')),
    loadPrompt(path.join(PROMPTS_DIR, command, 'command.md')),
  ]

  if (alias) {
    parts.push(loadPrompt(path.join(PROMPTS_DIR, command, `${alias}.md`)))
  }

  return parts.filter(Boolean).join('\n\n---\n\n')
}

async function ask(userMessage, command = 'ai', alias = null, options = {}) {
  const systemPrompt = buildSystemPrompt(command, alias)

  if (VERBOSE) {
    log.debug({ command, alias: alias || 'none' }, 'gemini request')
    log.debug({ systemPrompt }, 'gemini system prompt')
    log.debug({ userMessage }, 'gemini user message')
    if (options.location) log.debug({ location: options.location }, 'gemini location')
  }

  const schema = getSchema(command)

  const config = {
    systemInstruction: systemPrompt,
  }

  // Google Maps para localização, Google Search para texto livre
  if (options.location) {
    config.tools = [{ googleMaps: {} }]
    config.toolConfig = {
      retrievalConfig: {
        latLng: {
          latitude: options.location.lat,
          longitude: options.location.lng,
        },
      },
    }
  } else if (schema) {
    // JSON estruturado quando há schema e sem tools externas
    config.responseMimeType = 'application/json'
    config.responseSchema = schema
  } else {
    config.tools = [{ googleSearch: options.searchOptions || {} }]
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: userMessage,
    config,
  })

  let text = result.text || ''

  if (VERBOSE) {
    log.debug({ response: text || '(vazio)', finishReason: result.candidates?.[0]?.finishReason }, 'gemini response')
  }

  // se tem schema e JSON foi requisitado (sem tools externas), faz parse e formata
  if (schema && config.responseMimeType) {
    try {
      const data = JSON.parse(text)
      const formatted = format(command, data)
      return formatted || text
    } catch (err) {
      if (VERBOSE) log.error({ err }, 'gemini JSON parse error')
      return String(text).trim()
    }
  }

  // injeta links do Google Maps nos resultados, fazendo match por nome
  const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks || []

  for (const chunk of chunks) {
    if (!chunk.maps) continue
    const name = chunk.maps.title
    const uri = chunk.maps.uri
    if (!name || !uri) continue
    const idx = text.toLowerCase().indexOf(name.toLowerCase())
    if (idx !== -1) {
      const lineEnd = text.indexOf('\n', idx)
      if (lineEnd !== -1) {
        text = text.slice(0, lineEnd) + `\n${uri}` + text.slice(lineEnd)
      } else {
        text += `\n${uri}`
      }
    }
  }

  return String(text).trim()
}

module.exports = { ask }
