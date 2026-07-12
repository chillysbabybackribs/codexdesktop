/* Codex Desktop — landing interactions
   - Detect the visitor's OS and adapt the hero download button + highlight
     the matching platform card.
   - Reveal capability cards on scroll (respecting reduced-motion).
   No dependencies; progressive enhancement — the page is fully usable if this
   never runs. */

(function () {
  'use strict'

  var RELEASES = 'https://github.com/chillysbabybackribs/codexdesktop/releases/latest'

  var PLATFORMS = {
    mac: { key: 'mac', label: 'Download for macOS', sub: 'Universal · .dmg', ext: '.dmg' },
    windows: { key: 'windows', label: 'Download for Windows', sub: 'x64 · .exe', ext: '.exe' },
    linux: { key: 'linux', label: 'Download for Linux', sub: 'AppImage', ext: '.AppImage' }
  }

  var OS_ICONS = {
    mac: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.3 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.8-3.5.8-.7 0-1.9-.8-3.1-.8-1.6 0-3 .9-3.8 2.4-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.4-.9-2.4-3.9ZM14.1 5.6c.6-.8 1-1.9.9-3-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.8-1 2.8 1 .1 2-.5 2.7-1.2Z"/></svg>',
    windows: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.4 10.5 4.3v7.2H3V5.4Zm0 13.2L10.5 19.7v-7.1H3v6ZM11.5 4.1 21 2.8v8.7h-9.5V4.1Zm0 8.4H21v8.7l-9.5-1.3v-7.4Z"/></svg>',
    linux: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5c-2 0-3.2 1.7-3.2 3.9 0 1.3.2 2-.5 3.2-.8 1.3-2.4 2.9-2.4 5.3 0 .8.2 1.4.2 1.9-.4.4-1.1 1-.9 1.7.2.6 1 .6 1.8.8.8.2 1.4.7 2.2.8.6.1 1.2-.3 1.4-.9h2.8c.2.6.8 1 1.4.9.8-.1 1.4-.6 2.2-.8.8-.2 1.6-.2 1.8-.8.2-.7-.5-1.3-.9-1.7 0-.5.2-1.1.2-1.9 0-2.4-1.6-4-2.4-5.3-.7-1.2-.5-1.9-.5-3.2 0-2.2-1.2-3.9-3.2-3.9Z"/></svg>'
  }

  function detectOS() {
    var ua = (navigator.userAgent || '').toLowerCase()
    var platform = (navigator.platform || '').toLowerCase()
    var uaData = navigator.userAgentData
    var plat = uaData && uaData.platform ? uaData.platform.toLowerCase() : ''

    var hay = ua + ' ' + platform + ' ' + plat
    // iPadOS reports as Mac; treat any Apple hardware as mac for the desktop app.
    if (/mac|iphone|ipad|ipod|darwin/.test(hay)) return 'mac'
    if (/win/.test(hay)) return 'windows'
    if (/linux|x11|cros|ubuntu|fedora/.test(hay)) return 'linux'
    return null
  }

  function applyDownloadCTA(os) {
    var btn = document.querySelector('[data-download-primary]')
    if (!btn) return
    var labelEl = btn.querySelector('[data-download-label]')
    var subEl = btn.querySelector('[data-download-sub]')
    var iconEl = btn.querySelector('[data-os-icon]')

    if (os && PLATFORMS[os]) {
      var p = PLATFORMS[os]
      if (labelEl) labelEl.textContent = p.label
      if (subEl) subEl.textContent = p.sub
      if (iconEl) iconEl.innerHTML = OS_ICONS[os] || ''
      // Hero button still routes to the download section so all platforms stay
      // one click away; the visible label is what adapts.
      btn.setAttribute('href', '#download')
    } else {
      if (labelEl) labelEl.textContent = 'Download Codex Desktop'
      if (subEl) subEl.textContent = ''
      if (iconEl) iconEl.innerHTML = ''
    }
  }

  function highlightPlatform(os) {
    var cards = document.querySelectorAll('[data-platform]')
    var detectedCard = null
    cards.forEach(function (card) {
      var badge = card.querySelector('[data-badge]')
      if (os && card.getAttribute('data-platform') === os) {
        card.classList.add('is-detected')
        if (badge) badge.hidden = false
        detectedCard = card
      } else {
        card.classList.remove('is-detected')
        if (badge) badge.hidden = true
      }
    })

    // Float the detected platform to the front of the row.
    if (detectedCard && detectedCard.parentElement) {
      detectedCard.parentElement.insertBefore(detectedCard, detectedCard.parentElement.firstChild)
    }

    var note = document.querySelector('[data-detected-note]')
    if (note && os && PLATFORMS[os]) {
      var name = os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux'
      note.innerHTML = 'Detected <b>' + name + '</b> — grab the ' + PLATFORMS[os].ext + ', or pick another platform below.'
    }
  }

  function ensureReleaseLinks() {
    document.querySelectorAll('[data-dl]').forEach(function (a) {
      if (!a.getAttribute('href')) a.setAttribute('href', RELEASES)
    })
  }

  function revealOnScroll() {
    var items = document.querySelectorAll('[data-reveal]')
    if (!items.length) return
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-in') })
      return
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in')
          io.unobserve(entry.target)
        }
      })
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 })
    items.forEach(function (el) { io.observe(el) })
  }

  function init() {
    var os = detectOS()
    applyDownloadCTA(os)
    highlightPlatform(os)
    ensureReleaseLinks()
    revealOnScroll()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
