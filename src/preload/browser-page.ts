import { ipcRenderer } from 'electron'

// Channel name duplicated from shared/ipc.ts ipcChannels on purpose: preloads
// run sandboxed and cannot require() the shared chunk rollup emits for a
// cross-entry runtime import (it broke window.api in every preload), so each
// preload entry must stay self-contained. Type-only imports are fine.
const selectionCopyChannel = 'browser:selectionCopy'

const dragThreshold = 4
let pointerStart: { x: number; y: number } | null = null

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
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

  const text = window.getSelection()?.toString() ?? ''
  if (text.trim()) ipcRenderer.send(selectionCopyChannel, text)
}, true)

window.addEventListener('pointercancel', () => {
  pointerStart = null
}, true)
