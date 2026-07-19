import { useEffect, useRef, useState } from 'react';
import type { Model, ReasoningEffort } from '../../shared/session-protocol';

type ModelSelectionProps = {
  models: Model[];
  selectedModel: string | null;
};

function activeModelFor({ models, selectedModel }: ModelSelectionProps): Model | undefined {
  return (
    models.find((model) => model.model === selectedModel) ??
    models.find((model) => model.isDefault) ??
    models[0]
  );
}

function useDismissibleMenu(
  isOpen: boolean,
  setIsOpen: (open: boolean) => void,
  wrapRef: React.RefObject<HTMLDivElement | null>,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, setIsOpen, triggerRef, wrapRef]);
}

export function ModelSelector({
  models,
  selectedModel,
  onSelectModel,
  fastMode = false,
  onToggleFastMode,
}: ModelSelectionProps & {
  onSelectModel: (model: string) => void;
  fastMode?: boolean;
  onToggleFastMode?: (enabled: boolean) => void;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useDismissibleMenu(isOpen, setIsOpen, wrapRef, triggerRef);

  const active = activeModelFor({ models, selectedModel });
  const canToggleFastMode = Boolean(
    onToggleFastMode && (active?.providerId !== 'claude' || active.supportsFastMode === true),
  );

  return (
    <div ref={wrapRef} className="model-selector-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="selector-trigger model-selector-trigger"
        title={active ? `${active.displayName} — ${active.description}` : 'Choose model'}
        aria-label={`Model: ${active?.displayName ?? 'Choose model'}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="selector-trigger-label">{active?.displayName ?? 'Model'}</span>
      </button>

      {isOpen ? (
        <div className="selector-menu-shell model-menu-shell">
          <div className="model-menu" role="menu" aria-label="Models">
            <div className="selector-menu-heading">Models</div>
            {models.map((model) => {
              const isActive = model.model === active?.model;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={`model-option ${isActive ? 'is-active' : ''}`}
                  title={model.description}
                  onClick={() => {
                    onSelectModel(model.model);
                    setIsOpen(false);
                    window.requestAnimationFrame(() => triggerRef.current?.focus());
                  }}
                >
                  <span className="model-option-name">{model.displayName}</span>
                  {model.isDefault ? <span className="model-option-badge">Default</span> : null}
                  <span className="model-option-spacer" />
                  {isActive ? (
                    <span className="model-option-check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}

            {canToggleFastMode && onToggleFastMode ? (
              <div className="fast-mode-setting">
                <span className="fast-mode-copy">
                  <span className="fast-mode-label">Fast mode</span>
                  <span className="fast-mode-description">Lower effort for simple requests</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={fastMode}
                  aria-label={`${fastMode ? 'Disable' : 'Enable'} Fast mode`}
                  className={`fast-mode-switch ${fastMode ? 'is-active' : ''}`}
                  onClick={() => onToggleFastMode(!fastMode)}
                >
                  <span className="fast-mode-switch-knob" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function EffortSelector({
  models,
  selectedModel,
  selectedEffort,
  onSelectEffort,
}: ModelSelectionProps & {
  selectedEffort: ReasoningEffort | null;
  onSelectEffort: (model: string, effort: ReasoningEffort) => void;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useDismissibleMenu(isOpen, setIsOpen, wrapRef, triggerRef);

  const active = activeModelFor({ models, selectedModel });
  const efforts = active?.supportedReasoningEfforts ?? [];
  const effectiveEffort =
    selectedEffort ?? active?.defaultReasoningEffort ?? efforts[0]?.reasoningEffort ?? null;
  const activeIndex = efforts.findIndex((option) => option.reasoningEffort === effectiveEffort);
  const label = effectiveEffort ? reasoningEffortLabel(effectiveEffort) : 'Default';
  const unavailable = !active || !efforts.length;

  const selectEffort = (effort: ReasoningEffort, closeMenu = true): void => {
    if (!active) return;
    onSelectEffort(active.model, effort);
    if (closeMenu) {
      setIsOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  return (
    <div ref={wrapRef} className="effort-selector-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="selector-trigger effort-selector-trigger"
        title={unavailable ? 'This model has no effort options' : `Reasoning effort: ${label}`}
        aria-label={`Reasoning effort: ${label}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={unavailable}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="selector-trigger-label">{label}</span>
      </button>

      {isOpen && active ? (
        <div className="selector-menu-shell effort-menu-shell">
          <div className="effort-menu" role="menu" aria-label={`${active.displayName} effort`}>
            <div className="effort-menu-heading">
              <span>Effort</span>
              <strong>{label}</strong>
              <span
                className="effort-help"
                title="Higher effort spends more time reasoning before responding."
                aria-label="Higher effort spends more time reasoning before responding."
              >
                ?
              </span>
            </div>
            <div className="effort-scale-labels" aria-hidden="true">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div
              className="effort-scale"
              role="radiogroup"
              aria-label="Reasoning effort"
              style={{ '--effort-count': efforts.length } as React.CSSProperties}
            >
              {efforts.map((option, index) => {
                const isActive = option.reasoningEffort === effectiveEffort;
                return (
                  <button
                    key={option.reasoningEffort}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={`${reasoningEffortLabel(option.reasoningEffort)}: ${option.description}`}
                    className={`effort-step ${isActive ? 'is-active' : ''}`}
                    title={`${reasoningEffortLabel(option.reasoningEffort)} — ${option.description}`}
                    onClick={() => selectEffort(option.reasoningEffort)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      const direction = event.key === 'ArrowRight' ? 1 : -1;
                      const nextIndex = Math.min(
                        efforts.length - 1,
                        Math.max(0, index + direction),
                      );
                      const next = efforts[nextIndex];
                      if (next) selectEffort(next.reasoningEffort, false);
                    }}
                  >
                    <span className="effort-step-dot" />
                  </button>
                );
              })}
            </div>
            <div className="effort-menu-description">
              {activeIndex >= 0
                ? efforts[activeIndex]?.description
                : 'Choose how deeply the model reasons.'}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return (
    (
      {
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra High',
        max: 'Maximum',
        ultra: 'Ultra',
      } as Record<string, string>
    )[effort] ?? effort
  );
}
