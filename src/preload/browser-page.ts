import { ipcRenderer } from 'electron'
import { ipcChannels } from '../shared/ipc.js'

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
  if (text.trim()) ipcRenderer.send(ipcChannels.browserSelectionCopy, text)
}, true)

window.addEventListener('pointercancel', () => {
  pointerStart = null
}, true)
