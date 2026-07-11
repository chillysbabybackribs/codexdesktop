import { ipcRenderer } from 'electron'

// Channel name duplicated from shared/ipc.ts ipcChannels on purpose: preloads
// run sandboxed and cannot require() the shared chunk rollup emits for a
// cross-entry runtime import (it broke window.api in every preload), so each
// preload entry must stay self-contained. Type-only imports are fine.
const selectionCopyChannel = 'browser:selectionCopy'

const dragThreshold = 4
let pointerStart: { x: number; y: number } | null = null
let copyToast: HTMLElement | null = null
let copyToastTimer: ReturnType<typeof setTimeout> | null = null

function installSelectionStyle(): void {
  const selectionStyle = document.createElement('style')
  selectionStyle.textContent = '::selection { background: rgba(66, 133, 244, 0.28); color: inherit; }'
  ;(document.head ?? document.documentElement).appendChild(selectionStyle)
}

if (document.head || document.documentElement) {
  installSelectionStyle()
} else {
  window.addEventListener('DOMContentLoaded', installSelectionStyle, { once: true })
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
}

function showCopiedToast(x: number, y: number): void {
  copyToast?.remove()
  if (copyToastTimer) clearTimeout(copyToastTimer)

  const host = document.createElement('div')
  host.style.cssText = [
    'position:fixed',
    `left:${Math.max(12, Math.min(x + 14, window.innerWidth - 116))}px`,
    `top:${Math.max(12, Math.min(y + 14, window.innerHeight - 48))}px`,
    'z-index:2147483647',
    'pointer-events:none'
  ].join(';')
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>
    .toast { display:flex; align-items:center; gap:7px; padding:9px 12px; border:1px solid rgba(255,255,255,.24); border-radius:8px; background:#222; color:#f2f2f2; box-shadow:0 8px 24px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06); font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif; letter-spacing:.01em; animation:in 160ms ease-out; white-space:nowrap }
    .mark { display:grid; width:16px; height:16px; place-items:center; border:1px solid rgba(255,255,255,.3); border-radius:50%; font-size:10px }
    @keyframes in { from { opacity:0; transform:translateY(4px) scale(.97) } to { opacity:1; transform:none } }
    @media (prefers-reduced-motion:reduce) { .toast { animation:none } }
  </style><div class="toast" role="status"><span class="mark">✓</span><span>Copied</span></div>`
  document.documentElement.appendChild(host)
  copyToast = host
  copyToastTimer = setTimeout(() => {
    host.remove()
    if (copyToast === host) copyToast = null
  }, 1_350)
}

window.addEventListener('pointerdown', (event) => {
  pointerStart = event.button === 0 && !isEditable(event.target)
    ? { x: event.clientX, y: event.clientY }
    : null
}, true)

window.addEventListener('pointerup', (event) => {
  const start = pointerStart
  pointerStart = null
  if (!start || isEditable(event.target)) return
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < dragThreshold) return

  const selection = window.getSelection()
  const text = selection?.toString() ?? ''
  if (text.trim()) {
    ipcRenderer.send(selectionCopyChannel, text)
    selection?.removeAllRanges()
    showCopiedToast(event.clientX, event.clientY)
  }
}, true)

window.addEventListener('pointercancel', () => {
  pointerStart = null
}, true)
