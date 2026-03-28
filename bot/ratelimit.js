const limits = new Map()

function key(id, window) {
  return `${id}:${window}`
}

function check(id, maxRequests, windowMs) {
  const k = key(id, windowMs)
  const now = Date.now()

  if (!limits.has(k)) {
    limits.set(k, [])
  }

  const timestamps = limits.get(k).filter((t) => now - t < windowMs)
  limits.set(k, timestamps)

  if (timestamps.length >= maxRequests) {
    const oldestTs = timestamps[0]
    const waitSec = Math.ceil((windowMs - (now - oldestTs)) / 1000)
    return { allowed: false, waitSec }
  }

  timestamps.push(now)
  return { allowed: true }
}

module.exports = { check }
