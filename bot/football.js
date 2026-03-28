const { GoogleGenAI } = require('@google/genai')
const fs = require('fs')
const path = require('path')
const log = require('./logger')

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY
const FOOTBALL_BASE = 'https://v3.football.api-sports.io'
const VERBOSE = process.env.VERBOSE === 'true'

const PROMPTS_DIR = path.join(__dirname, 'prompts')
const RULES = fs.readFileSync(path.join(PROMPTS_DIR, 'RULES.md'), 'utf-8').trim()

function loadFootballPrompt() {
  const command = fs.readFileSync(path.join(PROMPTS_DIR, 'fut', 'command.md'), 'utf-8').trim()
  const context = fs.readFileSync(path.join(PROMPTS_DIR, 'fut', 'context.md'), 'utf-8').trim()
  const today = new Date().toISOString().split('T')[0]
  return `${RULES}\n\n---\n\n${command}\n\n---\n\n${context}\n\nToday's date: ${today}.`
}

// --- function declarations for Gemini ---
const footballFunctions = [
  {
    name: 'get_fixtures',
    description: 'Get football matches/fixtures. Use for: live games, today\'s games, upcoming matches, results, scores. Can filter by date, team, league.',
    parameters: {
      type: 'object',
      properties: {
        live: { type: 'string', description: 'Set to "all" to get all live matches', enum: ['all'] },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        team: { type: 'integer', description: 'Team ID' },
        league: { type: 'integer', description: 'League ID' },
        season: { type: 'integer', description: 'Season year (e.g. 2025)' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD for range' },
        to: { type: 'string', description: 'End date YYYY-MM-DD for range' },
        status: { type: 'string', description: 'Match status filter', enum: ['NS', 'LIVE', 'FT', '1H', '2H', 'HT'] },
      },
    },
  },
  {
    name: 'get_standings',
    description: 'Get league standings/classification/table. Use for: who is first, league table, points, team position.',
    parameters: {
      type: 'object',
      properties: {
        league: { type: 'integer', description: 'League ID (required)' },
        season: { type: 'integer', description: 'Season year (required, e.g. 2025)' },
        team: { type: 'integer', description: 'Filter by team ID' },
      },
      required: ['league', 'season'],
    },
  },
  {
    name: 'get_topscorers',
    description: 'Get top scorers/goal scorers of a league. Use for: who scored most goals, best strikers, leading scorers.',
    parameters: {
      type: 'object',
      properties: {
        league: { type: 'integer', description: 'League ID (required)' },
        season: { type: 'integer', description: 'Season year (required)' },
      },
      required: ['league', 'season'],
    },
  },
  {
    name: 'get_topassists',
    description: 'Get top assist providers of a league.',
    parameters: {
      type: 'object',
      properties: {
        league: { type: 'integer', description: 'League ID (required)' },
        season: { type: 'integer', description: 'Season year (required)' },
      },
      required: ['league', 'season'],
    },
  },
  {
    name: 'get_team_statistics',
    description: 'Get detailed statistics for a team in a league/season. Goals, wins, draws, losses, clean sheets, etc.',
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'integer', description: 'Team ID (required)' },
        league: { type: 'integer', description: 'League ID (required)' },
        season: { type: 'integer', description: 'Season year (required)' },
      },
      required: ['team', 'league', 'season'],
    },
  },
  {
    name: 'get_head_to_head',
    description: 'Get head-to-head results between two teams. Historical confrontation.',
    parameters: {
      type: 'object',
      properties: {
        h2h: { type: 'string', description: 'Two team IDs separated by dash, e.g. "211-212" (required)' },
        last: { type: 'integer', description: 'Number of last matches to return' },
      },
      required: ['h2h'],
    },
  },
  {
    name: 'get_predictions',
    description: 'Get match predictions, win probability and advice for a fixture.',
    parameters: {
      type: 'object',
      properties: {
        fixture: { type: 'integer', description: 'Fixture ID (required)' },
      },
      required: ['fixture'],
    },
  },
  {
    name: 'get_injuries',
    description: 'Get player injuries for a fixture or league/season.',
    parameters: {
      type: 'object',
      properties: {
        fixture: { type: 'integer', description: 'Fixture ID' },
        league: { type: 'integer', description: 'League ID' },
        season: { type: 'integer', description: 'Season year' },
        team: { type: 'integer', description: 'Team ID' },
      },
    },
  },
  {
    name: 'get_transfers',
    description: 'Get player transfers for a team or player.',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'integer', description: 'Player ID' },
        team: { type: 'integer', description: 'Team ID' },
      },
    },
  },
  {
    name: 'get_fixture_statistics',
    description: 'Get detailed statistics of a specific match (possession, shots, corners, etc.).',
    parameters: {
      type: 'object',
      properties: {
        fixture: { type: 'integer', description: 'Fixture ID (required)' },
        team: { type: 'integer', description: 'Filter by team ID' },
      },
      required: ['fixture'],
    },
  },
  {
    name: 'get_fixture_events',
    description: 'Get events of a match (goals, cards, substitutions).',
    parameters: {
      type: 'object',
      properties: {
        fixture: { type: 'integer', description: 'Fixture ID (required)' },
      },
      required: ['fixture'],
    },
  },
  {
    name: 'get_fixture_lineups',
    description: 'Get lineups/starting 11 of a match.',
    parameters: {
      type: 'object',
      properties: {
        fixture: { type: 'integer', description: 'Fixture ID (required)' },
      },
      required: ['fixture'],
    },
  },
  {
    name: 'search_team',
    description: 'Search for a team by name to get its ID. Always use this first if you don\'t know the team ID.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Team name to search (required)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_league',
    description: 'Search for a league/competition by name to get its ID. Always use this first if you don\'t know the league ID.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'League name to search (required)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_player',
    description: 'Search for a player by name in a specific team or league.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Player name (required, min 3 chars)' },
        team: { type: 'integer', description: 'Team ID' },
        league: { type: 'integer', description: 'League ID' },
        season: { type: 'integer', description: 'Season year' },
      },
      required: ['search'],
    },
  },
]

// --- map function name → API endpoint ---
const endpointMap = {
  get_fixtures: '/fixtures',
  get_standings: '/standings',
  get_topscorers: '/players/topscorers',
  get_topassists: '/players/topassists',
  get_team_statistics: '/teams/statistics',
  get_head_to_head: '/fixtures/headtohead',
  get_predictions: '/predictions',
  get_injuries: '/injuries',
  get_transfers: '/transfers',
  get_fixture_statistics: '/fixtures/statistics',
  get_fixture_events: '/fixtures/events',
  get_fixture_lineups: '/fixtures/lineups',
  search_team: '/teams',
  search_league: '/leagues',
  search_player: '/players',
}

// --- call API-Football ---
async function callFootballAPI(endpoint, params) {
  // many endpoints require 'season' — add default if missing
  const needsSeason = ['/fixtures', '/injuries', '/transfers', '/players', '/players/topscorers', '/players/topassists', '/teams/statistics']
  if (needsSeason.includes(endpoint) && !params.season && !params.date && !params.live) {
    params.season = new Date().getFullYear()
  }

  // /fixtures requires 'to' when using 'from'
  if (endpoint === '/fixtures' && params.from && !params.to) {
    const d = new Date(params.from)
    d.setDate(d.getDate() + 30)
    params.to = d.toISOString().split('T')[0]
  }

  const url = new URL(FOOTBALL_BASE + endpoint)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  }

  if (VERBOSE) log.debug({ url: url.toString() }, 'football API call')

  const res = await fetch(url, {
    headers: { 'x-apisports-key': FOOTBALL_API_KEY },
  })

  const data = await res.json()

  if (VERBOSE) log.debug({ results: data.results, errors: data.errors }, 'football API response')

  return data
}

// --- main ask function ---
async function ask(question) {
  const systemPrompt = loadFootballPrompt()

  const config = {
    systemInstruction: systemPrompt,
    tools: [{
      functionDeclarations: footballFunctions,
    }],
  }

  let contents = [{ role: 'user', parts: [{ text: question }] }]
  const MAX_ROUNDS = 4

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (VERBOSE) log.debug({ round, contents: contents.length }, 'gemini football round')

    const result = await ai.models.generateContent({
      model: MODEL,
      contents,
      config,
    })

    const candidate = result.candidates?.[0]
    const parts = candidate?.content?.parts || []

    // check if Gemini wants to call functions
    const functionCalls = parts.filter(p => p.functionCall)

    if (functionCalls.length === 0) {
      // Gemini responded with text — we're done
      const text = parts.map(p => p.text).filter(Boolean).join('')
      log.info({ round, responseLength: text.length }, 'football: Gemini final response')
      if (VERBOSE) log.debug({ response: text.slice(0, 300) }, 'football: response preview')
      return String(text).trim()
    }

    // add Gemini's response to conversation
    contents.push({ role: 'model', parts })

    // execute all function calls
    const functionResponses = []
    for (const part of functionCalls) {
      const { name, args } = part.functionCall
      const endpoint = endpointMap[name]

      log.info({ function: name, args }, 'football: Gemini requested function call')

      if (!endpoint) {
        log.warn({ name }, 'football: unknown function')
        functionResponses.push({
          functionResponse: { name, response: { error: `Unknown function: ${name}` } },
        })
        continue
      }

      try {
        const apiResult = await callFootballAPI(endpoint, args || {})
        const response = apiResult.response || []
        const trimmed = Array.isArray(response) ? response.slice(0, 20) : response

        log.info({
          function: name,
          endpoint,
          results: apiResult.results,
          errors: apiResult.errors,
          dataLength: Array.isArray(response) ? response.length : 'object',
        }, 'football: API response')

        if (VERBOSE) log.debug({ data: JSON.stringify(trimmed).slice(0, 500) }, 'football: API data preview')

        functionResponses.push({
          functionResponse: { name, response: { data: trimmed, results: apiResult.results } },
        })
      } catch (err) {
        log.error({ err, name, endpoint }, 'football: API error')
        functionResponses.push({
          functionResponse: { name, response: { error: err.message } },
        })
      }
    }

    // send results back to Gemini
    contents.push({ role: 'user', parts: functionResponses })
  }

  return 'Não consegui obter os dados. Tenta reformular a pergunta.'
}

module.exports = { ask }
