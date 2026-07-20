import type { BrowserMenuCommand, BrowserMenuRenderPayload } from '../../shared/ipc'

// Mirrors browserMenuApi in src/preload/browser-menu.ts (the preload project
// isn't part of the web tsconfig, so the shape is declared structurally).
declare global {
  interface Window {
    browserMenu: {
      onRender: (listener: (payload: BrowserMenuRenderPayload) => void) => () => void
      command: (command: BrowserMenuCommand) => void
    }
  }
}

const icons: Record<string, string> = {
  find: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><circle cx="10.8" cy="10.8" r="5.8" stroke="currentColor" stroke-width="1.8"/><path d="m15.2 15.2 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M4.5 10h3.2L12 6.5v11l-4.3-3.5H4.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.7a7.4 7.4 0 0 1 0 10.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  'volume-muted':
    '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M4.5 10h3.2L12 6.5v11l-4.3-3.5H4.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m15.5 10.2 4 4m0-4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M12 3.4 5.6 5.9v5.4c0 4 2.6 6.9 6.4 8.7 3.8-1.8 6.4-4.7 6.4-8.7V5.9L12 3.4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  fullscreen:
    '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M5 9.5V5h4.5M19 9.5V5h-4.5M5 14.5V19h4.5M19 14.5V19h-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'fullscreen-exit':
    '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M9.5 5v4.5H5M14.5 5v4.5H19M9.5 19v-4.5H5M14.5 19v-4.5H19" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  zoom: '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><circle cx="10.8" cy="10.8" r="5.8" stroke="currentColor" stroke-width="1.8"/><path d="m15.2 15.2 4 4M8.3 10.8h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="m5.5 12.5 4.2 4.2 8.8-9.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  minus:
    '<svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M5.5 12h13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>'
}

const card = document.getElementById('card') as HTMLDivElement

// pointerdown, not click: the click's mouseup can be lost when focus shifts
// back to the main renderer and the popup gets hidden mid-press.
function commandOnPointerDown(element: HTMLElement, command: BrowserMenuCommand): void {
  element.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    window.browserMenu.command(command)
  })
}

function render(payload: BrowserMenuRenderPayload): void {
  card.replaceChildren(
    ...payload.items.map((item) => {
      if (item.kind === 'separator') {
        const row = document.createElement('div')
        row.className = 'separator'
        return row
      }

      if (item.kind === 'zoom') {
        const row = document.createElement('div')
        row.className = 'zoom-row'

        const icon = document.createElement('span')
        icon.className = 'row-icon'
        icon.innerHTML = icons.zoom

        const label = document.createElement('span')
        label.className = 'row-label'
        label.textContent = 'Zoom'

        const controls = document.createElement('span')
        controls.className = 'zoom-controls'

        const zoomButton = (command: BrowserMenuCommand, html: string, title: string): HTMLButtonElement => {
          const button = document.createElement('button')
          button.type = 'button'
          button.title = title
          button.innerHTML = html
          button.disabled = Boolean(item.disabled)
          if (!item.disabled) commandOnPointerDown(button, command)
          return button
        }

        const reset = zoomButton('zoom-reset', '', 'Reset zoom')
        reset.classList.add('zoom-value')
        reset.textContent = `${item.percent}%`

        controls.append(
          zoomButton('zoom-out', icons.minus, 'Zoom out'),
          reset,
          zoomButton('zoom-in', icons.plus, 'Zoom in')
        )
        row.append(icon, label, controls)
        return row
      }

      const row = document.createElement('div')
      row.className = `row${item.disabled ? ' is-disabled' : ''}`

      const icon = document.createElement('span')
      icon.className = 'row-icon'
      icon.innerHTML = icons[item.icon] ?? ''

      const label = document.createElement('span')
      label.className = 'row-label'
      label.textContent = item.label

      const check = document.createElement('span')
      check.className = 'row-check'
      if (item.checked) check.innerHTML = icons.check

      row.append(icon, label, check)
      if (!item.disabled) commandOnPointerDown(row, item.command)
      return row
    })
  )
}

window.browserMenu.onRender(render)
