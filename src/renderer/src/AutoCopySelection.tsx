import { useEffect, useRef, useState } from 'react'

const dragThreshold = 4

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
}

export function AutoCopySelection(): React.JSX.Element | null {
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const showCopied = (): void => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setVisible(true)
      hideTimer.current = setTimeout(() => setVisible(false), 1_250)
    }
    const stopListeningForBrowserCopies = window.api.clipboard.onAutoCopied(showCopied)

    const onPointerDown = (event: globalThis.PointerEvent): void => {
      pointerStart.current = event.button === 0 && !isEditable(event.target)
        ? { x: event.clientX, y: event.clientY }
        : null
    }
    const onPointerUp = (event: globalThis.PointerEvent): void => {
      const start = pointerStart.current
      pointerStart.current = null
      if (!start || isEditable(event.target)) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < dragThreshold) return

      const text = window.getSelection()?.toString() ?? ''
      if (text.trim()) void window.api.clipboard.writeText(text)
    }
    const onPointerCancel = (): void => { pointerStart.current = null }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    return () => {
      stopListeningForBrowserCopies()
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerCancel, true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  return visible ? <div className="auto-copy-toast" role="status" aria-live="polite">Copied</div> : null
}
