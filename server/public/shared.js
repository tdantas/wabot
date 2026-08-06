/* === WABot shared utilities === */

// XSS escape
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

// Debounce
const _debounceTimers = {}
function debounce(key, fn, ms = 800) {
  clearTimeout(_debounceTimers[key])
  _debounceTimers[key] = setTimeout(fn, ms)
}

// Mode detection
const LIVE = location.pathname.startsWith('/live/')
const ADMIN = location.pathname.startsWith('/admin/')
const PAGE_PREFIX = LIVE ? '/live' : ADMIN ? '/admin' : ''

// Live 401 interceptor
if (LIVE) {
  const _fetch = window.fetch
  window.fetch = function(url, opts) {
    return _fetch(url, opts).then(res => {
      if (res.status === 401) {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:Outfit,system-ui,sans-serif;background:#0a0b0f;color:#e8e6e1;margin:0"><div style="text-align:center;padding:48px;border-radius:16px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.06);max-width:400px"><h1 style="font-size:1.4rem;margin-bottom:12px;color:#e8a832">Acesso expirado</h1><p style="color:#a09d95;font-size:0.9rem;line-height:1.5">O teu acesso expirou. Peça um novo link com <b>!live</b> no grupo.</p></div></div>'
        throw new Error('unauthorized')
      }
      return res
    })
  }
}

// Group ID from URL — path-based first, fallback to query param
const params = new URLSearchParams(location.search)
const _pathMatch = location.pathname.match(/\/group\/([^/]+)/)
const groupId = _pathMatch ? decodeURIComponent(_pathMatch[1]) : params.get('id')

// Helper to build group page URL
function groupUrl(page, extra) {
  const base = `${PAGE_PREFIX}/group/${encodeURIComponent(groupId)}/${page}`
  return extra ? `${base}?${extra}` : base
}

// Fetch with error handling
const FETCH_OPTS = { cache: 'no-cache' }
async function apiFetch(path, extra = '') {
  const url = `${PAGE_PREFIX}${path}?group=${encodeURIComponent(groupId)}&${extra}`
  const res = await fetch(url, FETCH_OPTS)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Date helpers
function localDate(d) {
  return d.toLocaleString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hour12: false }).split(', ')[0]
}
function todayStr() { return localDate(new Date()) }
function daysAgoStr(n) { const d = new Date(); d.setDate(d.getDate() - n); return localDate(d) }

// Bottom navigation bar for detail pages
;(function initBottomNav() {
  if (!groupId) return

  const rawPage = location.pathname.split('/').pop()
  const page = rawPage.endsWith('.html') ? rawPage.replace('.html', '') : rawPage
  const detailPages = ['charts', 'calendar', 'race', 'list', 'settings']
  if (!detailPages.includes(page)) return

  const items = [
    { href: 'calendar', label: 'Calendário', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
    { href: 'charts', label: 'Gráficos', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>' },
    { href: 'list', label: 'Lista', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>' },
    { href: 'race', label: 'Race', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>' },
  ]

  if (ADMIN) {
    items.push({ href: 'settings', label: 'Definições', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' })
  }

  const adminGroupsLink = ADMIN
    ? `<a class="nav-groups" href="/admin/groups"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg><span>Grupos</span></a>`
    : ''

  const nav = document.createElement('nav')
  nav.className = 'bottom-nav'
  nav.innerHTML =
    `<div class="nav-brand"><span class="nav-brand-mark">W</span>WA<span>Bot</span></div>` +
    adminGroupsLink +
    items.map(item => {
      const active = page === item.href ? ' class="active"' : ''
      return `<a${active} href="${groupUrl(item.href)}">${item.icon}<span>${item.label}</span></a>`
    }).join('')

  document.body.appendChild(nav)
  document.body.classList.add('has-bottom-nav')
})()

// Web Share / clipboard
const _shareIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'

function canShare() { return !!(navigator.share || navigator.clipboard) }

async function shareResults(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text })
    } catch (e) {
      if (e.name !== 'AbortError') console.error('Share failed', e)
    }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    showShareToast('Copiado!')
  }
}

function showShareToast(msg) {
  let t = document.getElementById('shareToast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'shareToast'
    t.className = 'share-toast'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 2000)
}

// Pull-to-refresh
function initPullToRefresh(onRefresh) {
  if (!('ontouchstart' in window)) return

  const indicator = document.createElement('div')
  indicator.className = 'ptr-indicator'
  indicator.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>'
  document.body.prepend(indicator)
  document.body.classList.add('has-ptr')

  let startY = 0, pulling = false, busy = false

  document.addEventListener('touchstart', (e) => {
    if (busy || window.scrollY > 0) return
    startY = e.touches[0].clientY
    pulling = true
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (!pulling) return
    const dy = e.touches[0].clientY - startY
    if (dy < 0) { pulling = false; return }
    const offset = Math.min(dy * 0.4, 70)
    indicator.style.transform = `translateX(-50%) translateY(${offset - 10}px)`
    indicator.style.opacity = Math.min(dy / 90, 1)
    indicator.style.transition = 'none'
  }, { passive: true })

  document.addEventListener('touchend', async () => {
    if (!pulling) return
    pulling = false
    indicator.style.transition = ''

    const opacity = parseFloat(indicator.style.opacity || 0)
    if (opacity >= 0.9 && !busy) {
      busy = true
      indicator.classList.add('refreshing')
      indicator.style.transform = 'translateX(-50%) translateY(16px)'
      indicator.style.opacity = '1'
      try { await onRefresh() } catch (e) { console.error('PTR refresh failed', e) }
      indicator.classList.remove('refreshing')
      busy = false
    }
    indicator.style.transform = 'translateX(-50%) translateY(-50px)'
    indicator.style.opacity = '0'
  })
}
