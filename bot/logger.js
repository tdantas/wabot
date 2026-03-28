const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.VERBOSE === 'true' ? 'debug' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime,
})

module.exports = logger
