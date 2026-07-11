import { useEffect, useRef, useState } from 'react'

const dragThreshold = 4

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
}

export function AutoCopySelection(): React.JSX.Element | null {
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [toast, setToast] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const showCopied = (x: number, y: number): void => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setToast({
        x: Math.max(12, Math.min(x + 14, window.innerWidth - 116)),
        y: Math.max(12, Math.min(y + 14, window.innerHeight - 48))
      })
      hideTimer.current = setTimeout(() => setToast(null), 1_350)
    }

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

      const selection = window.getSelection()
      const text = selection?.toString() ?? ''
      if (text.trim()) {
        const writeText = window.api?.clipboard?.writeText
        if (typeof writeText === 'function') {
          void Promise.resolve(writeText(text)).catch(() => {})
        }
        selection?.removeAllRanges()
        showCopied(event.clientX, event.clientY)
      }
    }
    const onPointerCancel = (): void => { pointerStart.current = null }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerCancel, true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  return toast ? (
    <div
      className="auto-copy-toast"
      role="status"
      aria-live="polite"
      style={{ left: toast.x, top: toast.y }}
    >
      <span className="auto-copy-toast-mark" aria-hidden="true">✓</span>
      <span>Copied</span>
    </div>
  ) : null
}
