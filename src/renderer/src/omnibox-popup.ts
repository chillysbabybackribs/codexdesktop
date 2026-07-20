import type { OmniboxRenderPayload } from '../../shared/ipc'

// Mirrors omniboxPopupApi in src/preload/omnibox-popup.ts (the preload project
// isn't part of the web tsconfig, so the shape is declared structurally).
declare global {
  interface Window {
    omniboxPopup: {
      onRender: (listener: (payload: OmniboxRenderPayload) => void) => () => void
      commit: (url: string) => void
    }
  }
}

const icons: Record<string, string> = {
  search:
    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  navigate:
    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5c1.6 0 2.8 2.5 2.8 5.5S9.6 13.5 8 13.5 5.2 11 5.2 8 6.4 2.5 8 2.5Z" stroke="currentColor" stroke-width="1.3"/><path d="M2.7 8h10.6" stroke="currentColor" stroke-width="1.3"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2.2 1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
}

const card = document.getElementById('card') as HTMLDivElement

function render(payload: OmniboxRenderPayload): void {
  card.replaceChildren(
    ...payload.suggestions.map((suggestion, index) => {
      const row = document.createElement('div')
      row.className = `row${index === payload.selectedIndex ? ' is-selected' : ''}`

      const icon = document.createElement('span')
      icon.className = 'row-icon'
      icon.innerHTML = icons[suggestion.kind] ?? icons.navigate

      const text = document.createElement('span')
      text.className = 'row-text'
      text.textContent = suggestion.text

      const detail = document.createElement('span')
      detail.className = 'row-detail'
      detail.textContent = suggestion.detail

      row.append(icon, text, detail)
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
