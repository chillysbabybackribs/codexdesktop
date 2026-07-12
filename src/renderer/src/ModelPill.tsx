import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import type { Model } from '../../shared/codex-protocol/v2/Model'

// Shared model selector pill: used by the main composer and by each agent
// window header. Lives in its own module so both App and AgentDock can import
// it without a cycle.
export function ModelPill({
  models,
  selectedModel,
  onSelectModel,
  selectedEffort,
  onSelectModelEffort
}: {
  models: Model[]
  selectedModel: string | null
  onSelectModel: (model: string) => void
  selectedEffort?: ReasoningEffort | null
  onSelectModelEffort?: (model: string, effort: ReasoningEffort) => void
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [expandedModel, setExpandedModel] = useState<string | null>(null)
  const [reasoningMenuPlacement, setReasoningMenuPlacement] = useState<{
    side: 'left' | 'right'
    top: number
  } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const menuShellRef = useRef<HTMLDivElement | null>(null)
  const expandedOptionRef = useRef<HTMLDivElement | null>(null)
  const reasoningMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        setExpandedModel(null)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const active =
    models.find((model) => model.model === selectedModel) ??
    models.find((model) => model.isDefault) ??
    models[0]
  const expandedIndex = models.findIndex((model) => model.model === expandedModel)
  const expanded = expandedIndex >= 0 ? models[expandedIndex] : null
  const expandedEfforts = expanded?.supportedReasoningEfforts ?? []

  useLayoutEffect(() => {
    if (!expandedModel || !expandedEfforts.length) {
      setReasoningMenuPlacement(null)
      return
    }

    const placeMenu = (): void => {
      const shell = menuShellRef.current
      const option = expandedOptionRef.current
      const menu = reasoningMenuRef.current
      if (!shell || !option || !menu) return

      const viewportPadding = 8
      const submenuGap = 8
      const shellRect = shell.getBoundingClientRect()
      const optionRect = option.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const preferredTop = optionRect.top - 6
      const viewportTop = Math.min(
        Math.max(preferredTop, viewportPadding),
        Math.max(viewportPadding, window.innerHeight - menuRect.height - viewportPadding)
      )
      const roomOnRight = window.innerWidth - shellRect.right - viewportPadding
      const roomOnLeft = shellRect.left - viewportPadding
      const side = roomOnRight >= menuRect.width + submenuGap || roomOnRight >= roomOnLeft
        ? 'right'
        : 'left'

      setReasoningMenuPlacement({ side, top: viewportTop - shellRect.top })
    }

    placeMenu()
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
    }
  }, [expandedModel, expandedEfforts.length])

  return (
    <div ref={wrapRef} className="model-pill-wrap">
      <button
        type="button"
        className="workspace-pill"
        title={active ? `${active.displayName} — ${active.description}` : 'Choose model'}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ModelIcon />
        <span className="workspace-pill-name">{active?.displayName ?? 'Model'}</span>
        <span className="workspace-pill-caret">⌄</span>
      </button>
      {isOpen ? (
        <div ref={menuShellRef} className="model-menu-shell" onMouseLeave={() => setExpandedModel(null)}>
          <div className="model-menu" role="menu">
            {models.map((model) => {
              const isActive = model.model === active?.model
              const efforts = model.supportedReasoningEfforts ?? []
              const hasEfforts = Boolean(onSelectModelEffort && efforts.length)
              const isExpanded = expandedModel === model.model && hasEfforts
              return (
                <div
                  key={model.id}
                  className="model-option-wrap"
                  onMouseEnter={(event) => {
                    expandedOptionRef.current = event.currentTarget
                    setExpandedModel(model.model)
                  }}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    aria-haspopup={hasEfforts ? 'menu' : undefined}
                    aria-expanded={hasEfforts ? isExpanded : undefined}
                    className={`model-option ${isActive ? 'is-active' : ''}`}
                    onFocus={(event) => {
                      expandedOptionRef.current = event.currentTarget.parentElement as HTMLDivElement | null
                      setExpandedModel(model.model)
                    }}
                    onClick={() => {
                      onSelectModel(model.model)
                      if (!hasEfforts) setIsOpen(false)
                    }}
                  >
                    <span className="model-option-copy">
                      <span className="model-option-name">
                        {model.displayName}
                        {model.isDefault ? <span className="model-option-badge">CLI default</span> : null}
                      </span>
                      <span className="model-option-desc">{model.description}</span>
                    </span>
                    {hasEfforts ? <span className="model-option-submenu-caret" aria-hidden="true">›</span> : null}
                  </button>
                </div>
              )
            })}
          </div>
          {expanded && onSelectModelEffort && expandedEfforts.length ? (
            <div
              ref={reasoningMenuRef}
              className="reasoning-menu"
              data-side={reasoningMenuPlacement?.side ?? 'right'}
              role="menu"
              aria-label={`${expanded.displayName} reasoning effort`}
              style={{
                top: reasoningMenuPlacement?.top ?? 0,
                visibility: reasoningMenuPlacement ? 'visible' : 'hidden'
              }}
            >
              <div className="reasoning-menu-label">Reasoning effort</div>
              {expandedEfforts.map((option) => {
                const isSelected = expanded.model === active?.model && option.reasoningEffort === selectedEffort
                return (
                  <button
                    key={option.reasoningEffort}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`reasoning-option ${isSelected ? 'is-active' : ''}`}
                    onClick={() => {
                      onSelectModelEffort(expanded.model, option.reasoningEffort)
                      setExpandedModel(null)
                      setIsOpen(false)
                    }}
                  >
                    <span>{reasoningEffortLabel(option.reasoningEffort)}</span>
                    <span className="reasoning-option-desc">{option.description}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
  return ({
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    ultra: 'Ultra'
  } as Record<string, string>)[effort] ?? effort
}

function ModelIcon(): React.JSX.Element {
  return (
    <svg className="workspace-pill-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 3.5v2M14 3.5v2M10 18.5v2M14 18.5v2M3.5 10h2M3.5 14h2M18.5 10h2M18.5 14h2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
