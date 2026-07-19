import type { OmniboxRenderPayload } from '../../shared/ipc'

// Mirrors omniboxPopupApi in src/preload/omnibox-popup.ts (the preload project
// isn't part of the web tsconfig, so the shape is declared structurally).
declare global {
  interface Window {
    omniboxPopup: {
      onRender: (listener: (payload: OmniboxRenderPayload) => void) => () => void
      commit: (url: string) => void
      deleteHistory: (url: string) => void
    }
  }
}

const icons: Record<string, string> = {
  search:
    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  navigate:
    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5c1.6 0 2.8 2.5 2.8 5.5S9.6 13.5 8 13.5 5.2 11 5.2 8 6.4 2.5 8 2.5Z" stroke="currentColor" stroke-width="1.3"/><path d="M2.7 8h10.6" stroke="currentColor" stroke-width="1.3"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" fill="none" width="16" height="16"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.75c1.9 0 3.25 2.8 3.25 6.25S9.9 14.25 8 14.25 4.75 11.45 4.75 8 6.1 1.75 8 1.75Z" stroke="currentColor" stroke-width="1.2"/><path d="M2 8h12M2.6 5.5h10.8M2.6 10.5h10.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
}

const card = document.getElementById('card') as HTMLDivElement
card.setAttribute('role', 'listbox')
card.setAttribute('aria-label', 'Address suggestions')

function trustedFavicon(value: string | null): string | null {
  if (!value || value.length > 128 * 1024) return null
  const lower = value.trim().toLowerCase()
  return lower.startsWith('https://') || lower.startsWith('data:image/') ? value : null
}

function renderIcon(suggestion: OmniboxRenderPayload['suggestions'][number]): HTMLSpanElement {
  const shell = document.createElement('span')
  shell.className = 'row-icon'
  shell.setAttribute('aria-hidden', 'true')

  const favicon = suggestion.kind === 'history' ? trustedFavicon(suggestion.favicon) : null
  if (!favicon) {
    shell.innerHTML = icons[suggestion.kind] ?? icons.navigate
    return shell
  }

  const image = document.createElement('img')
  image.className = 'row-favicon'
  image.alt = ''
  image.decoding = 'async'
  image.referrerPolicy = 'no-referrer'
  image.addEventListener('error', () => {
    shell.innerHTML = icons.history
  }, { once: true })
  image.src = favicon
  shell.append(image)
  return shell
}

function render(payload: OmniboxRenderPayload): void {
  card.replaceChildren(
    ...payload.suggestions.map((suggestion, index) => {
      const row = document.createElement('div')
      row.className = `row${index === payload.selectedIndex ? ' is-selected' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === payload.selectedIndex))
      row.setAttribute('aria-label', suggestion.detail ? `${suggestion.text}, ${suggestion.detail}` : suggestion.text)

      const icon = renderIcon(suggestion)

      const text = document.createElement('span')
      text.className = 'row-text'
      text.textContent = suggestion.text

      const detail = document.createElement('span')
      detail.className = 'row-detail'
      detail.textContent = suggestion.detail

      row.append(icon, text, detail)

      if (suggestion.kind === 'history') {
        const deleteButton = document.createElement('button')
        deleteButton.className = 'row-delete'
        deleteButton.type = 'button'
        deleteButton.title = 'Remove from history'
        deleteButton.setAttribute('aria-label', `Remove ${suggestion.text} from history`)
        deleteButton.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3.25h4V4.5m-5.25 0 .55 8.25h5.4l.55-8.25M6.75 6.5v4.25m2.5-4.25v4.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        deleteButton.addEventListener('pointerdown', (event) => {
          event.preventDefault()
          event.stopPropagation()
          window.omniboxPopup.deleteHistory(suggestion.url)
        })
        row.append(deleteButton)
      }
      // pointerdown, not click: the click's mouseup can be lost when focus
      // shifts away from the main renderer and the popup gets hidden mid-press.
      row.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        window.omniboxPopup.commit(suggestion.url)
      })

      return row
    })
  )
}

window.omniboxPopup.onRender(render)
