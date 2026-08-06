const { sql } = require('./db')

// Normalize Unicode fancy text (bold, italic, script, etc.) to plain ASCII/Latin
function normalizeName(name) {
  return name.normalize('NFKC').replace(/[\u{1D400}-\u{1D7FF}]/gu, ch => {
    const cp = ch.codePointAt(0)
    // Mathematical bold/italic/script/fraktur/sans/mono letters → ASCII
    // Each styled alphabet maps ranges of 52 chars (A-Z, a-z) to base letters
    const ranges = [
      [0x1D400, 0x1D419, 0x41], // Bold A-Z
      [0x1D41A, 0x1D433, 0x61], // Bold a-z
      [0x1D434, 0x1D44D, 0x41], // Italic A-Z
      [0x1D44E, 0x1D467, 0x61], // Italic a-z
      [0x1D468, 0x1D481, 0x41], // Bold Italic A-Z
      [0x1D482, 0x1D49B, 0x61], // Bold Italic a-z
      [0x1D49C, 0x1D4B5, 0x41], // Script A-Z
      [0x1D4B6, 0x1D4CF, 0x61], // Script a-z
      [0x1D4D0, 0x1D4E9, 0x41], // Bold Script A-Z
      [0x1D4EA, 0x1D503, 0x61], // Bold Script a-z
      [0x1D504, 0x1D51D, 0x41], // Fraktur A-Z
      [0x1D51E, 0x1D537, 0x61], // Fraktur a-z
      [0x1D538, 0x1D551, 0x41], // Double-struck A-Z
      [0x1D552, 0x1D56B, 0x61], // Double-struck a-z
      [0x1D56C, 0x1D585, 0x41], // Bold Fraktur A-Z
      [0x1D586, 0x1D59F, 0x61], // Bold Fraktur a-z
      [0x1D5A0, 0x1D5B9, 0x41], // Sans A-Z
      [0x1D5BA, 0x1D5D3, 0x61], // Sans a-z
      [0x1D5D4, 0x1D5ED, 0x41], // Sans Bold A-Z
      [0x1D5EE, 0x1D607, 0x61], // Sans Bold a-z
      [0x1D608, 0x1D621, 0x41], // Sans Italic A-Z
      [0x1D622, 0x1D63B, 0x61], // Sans Italic a-z
      [0x1D63C, 0x1D655, 0x41], // Sans Bold Italic A-Z
      [0x1D656, 0x1D66F, 0x61], // Sans Bold Italic a-z
      [0x1D670, 0x1D689, 0x41], // Monospace A-Z
      [0x1D68A, 0x1D6A3, 0x61], // Monospace a-z
      [0x1D6A8, 0x1D6C0, 0x391],// Bold Greek Α-Ω
      [0x1D6C2, 0x1D6DA, 0x3B1],// Bold Greek α-ω
      [0x1D7CE, 0x1D7D7, 0x30], // Bold digits 0-9
      [0x1D7D8, 0x1D7E1, 0x30], // Double-struck digits
      [0x1D7E2, 0x1D7EB, 0x30], // Sans digits
      [0x1D7EC, 0x1D7F5, 0x30], // Sans Bold digits
      [0x1D7F6, 0x1D7FF, 0x30], // Monospace digits
    ]
    for (const [start, end, base] of ranges) {
      if (cp >= start && cp <= end) return String.fromCodePoint(base + cp - start)
    }
    return ch
  })
}

// in-memory cache for jid_map (old_jid -> lid_jid)
const lidCache = new Map()

async function loadLidCache() {
  const rows = await sql`SELECT old_jid, lid_jid FROM jid_map`
  for (const r of rows) lidCache.set(r.old_jid, r.lid_jid)
}

// Map a @s.whatsapp.net JID to its @lid equivalent (if known)
function toLid(jid) {
  return lidCache.get(jid) || jid
}

// Register a mapping from old JID to LID
async function mapJid(oldJid, lidJid) {
  if (!oldJid || !lidJid) return
  if (oldJid === lidJid) return
  if (lidCache.get(oldJid) === lidJid) return
  lidCache.set(oldJid, lidJid)
  await sql`
    INSERT INTO jid_map (old_jid, lid_jid) VALUES (${oldJid}, ${lidJid})
    ON CONFLICT (old_jid) DO UPDATE SET lid_jid = EXCLUDED.lid_jid
  `
  // Migrate old contact name to new LID and clean up
  const [old] = await sql`SELECT name FROM contacts WHERE jid = ${oldJid}`
  if (old) {
    await sql`
      INSERT INTO contacts (jid, name, type) VALUES (${lidJid}, ${old.name}, 'person')
      ON CONFLICT (jid) DO NOTHING
    `
    await sql`DELETE FROM contacts WHERE jid = ${oldJid}`
  }
}

function typeFromJid(jid) {
  return jid.endsWith('@g.us') ? 'group' : 'person'
}

async function set(jid, name) {
  if (!name) return
  name = normalizeName(name)
  const resolved = toLid(jid)
  await sql`
    INSERT INTO contacts (jid, name, type) VALUES (${resolved}, ${name}, ${typeFromJid(resolved)})
    ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type
  `
}

async function getName(jid) {
  const resolved = toLid(jid)
  const [row] = await sql`SELECT name FROM contacts WHERE jid = ${resolved}`
  return row?.name || resolved.replace(/@(s\.whatsapp\.net|lid)$/, '')
}

module.exports = { set, getName, toLid, mapJid, loadLidCache }
