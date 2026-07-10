import { useEffect, useMemo, useState } from 'react'
import type { TurnTrace } from './trace'

export function TraceModal({ trace, onClose }: { trace: TurnTrace; onClose: () => void }): React.JSX.Element {
  const [actionStatus, setActionStatus] = useState('')
  const json = useMemo(() => `${JSON.stringify(trace, null, 2)}\n`, [trace])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    void window.api.browser.setOverlayOpen(true)
    return () => {
      window.removeEventListener('keydown', handleKey)
      void window.api.browser.setOverlayOpen(false)
    }
  }, [onClose])

  const copyTrace = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(json)
      setActionStatus('Copied JSON')
    } catch (error) {
      setActionStatus(`Copy failed: ${(error as Error).message}`)
    }
  }

  const saveTrace = async (): Promise<void> => {
    try {
      const result = await window.api.trace.save({
        suggestedName: `codex-trace-${trace.turn.id.slice(0, 12)}.json`,
        content: json
      })
      setActionStatus(result.saved ? `Saved ${result.path ?? 'trace'}` : 'Save canceled')
    } catch (error) {
      setActionStatus(`Save failed: ${(error as Error).message}`)
    }
  }

  const turnTokens = trace.usage.turn

  return (
    <div className="trace-overlay" onPointerDown={onClose}>
      <section
        className="trace-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Turn trace"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="trace-header">
          <div>
            <h2>Turn trace</h2>
            <p>{trace.thread.title}</p>
          </div>
          <div className="trace-header-actions">
            <button type="button" onClick={() => void copyTrace()}>Copy JSON</button>
            <button type="button" onClick={() => void saveTrace()}>Save JSON</button>
            <button type="button" className="trace-close" aria-label="Close trace" onClick={onClose}>×</button>
          </div>
        </header>

        <div className="trace-scroll">
          {trace.capture.completeness === 'partial' ? (
            <div className="trace-capture-warning" role="note">
              <strong>Partial trace</strong>
              <span>
                This turn was restored without {trace.capture.missing.join(', ') || 'all live telemetry'}.
                New completed turns are saved with the full live trace.
              </span>
            </div>
          ) : null}

          <section className="trace-summary-grid">
            <TraceMetric label="Status" value={trace.turn.status} />
            <TraceMetric label="Duration" value={formatDuration(trace.turn.durationMs)} />
            <TraceMetric label="Model" value={trace.environment.model ?? 'unknown'} />
            <TraceMetric label="Workspace" value={trace.environment.workspace ?? 'default'} mono />
            <TraceMetric label="Model calls" value={String(trace.usage.modelCallCount)} />
            <TraceMetric label="Commands" value={String(trace.summary.commandCount)} />
            <TraceMetric label="Tool calls" value={String(trace.summary.toolCallCount)} />
            <TraceMetric label="Browser calls" value={String(trace.summary.browserToolCount)} />
          </section>

          <section className="trace-section">
            <div className="trace-section-heading">
              <h3>Turn usage</h3>
              <span>
                Whole turn across {trace.usage.modelCallCount} model {trace.usage.modelCallCount === 1 ? 'call' : 'calls'}.
              </span>
            </div>
            <div className="trace-token-row">
              <TraceToken label="Total" value={turnTokens?.totalTokens} />
              <TraceToken label="Input" value={turnTokens?.inputTokens} />
              <TraceToken label="Cached" value={turnTokens?.cachedInputTokens} />
              <TraceToken label="Output" value={turnTokens?.outputTokens} />
              <TraceToken label="Reasoning" value={turnTokens?.reasoningOutputTokens} />
              <TraceToken label="Context window" value={trace.usage.modelContextWindow} />
            </div>
            {trace.usage.latestModelCall ? (
              <p className="trace-usage-note">
                Latest call: {formatTokens(trace.usage.latestModelCall.totalTokens)} tokens.
                Thread total at completion: {trace.usage.threadTotalAtEnd
                  ? formatTokens(trace.usage.threadTotalAtEnd.totalTokens)
                  : 'unknown'}.
              </p>
            ) : null}
          </section>

          <section className="trace-section trace-identifiers">
            <h3>Identity</h3>
            <dl>
              <dt>Thread</dt><dd>{trace.thread.id ?? 'not assigned'}</dd>
              <dt>Turn</dt><dd>{trace.turn.id}</dd>
              <dt>Started</dt><dd>{trace.turn.startedAt ?? 'unknown'}</dd>
              <dt>Completed</dt><dd>{trace.turn.completedAt ?? 'in progress'}</dd>
              <dt>Exported</dt><dd>{trace.exportedAt}</dd>
            </dl>
          </section>

          {trace.skills.length ? (
            <section className="trace-section">
              <h3>Skills</h3>
              {trace.skills.map((skill) => (
                <div className="trace-skill" key={skill.path}>
                  <strong>${skill.name}</strong>
                  <code>{skill.path}</code>
                </div>
              ))}
            </section>
          ) : null}

          {trace.environment.modelReroutes.length ? (
            <section className="trace-section trace-identifiers">
              <h3>Model reroutes</h3>
              <dl>
                {trace.environment.modelReroutes.flatMap((reroute, index) => [
                  <dt key={`${index}-time`}>{new Date(reroute.atMs).toLocaleTimeString()}</dt>,
                  <dd key={`${index}-route`}>
                    {reroute.fromModel} → {reroute.toModel} ({reroute.reason})
                  </dd>
                ])}
              </dl>
            </section>
          ) : null}

          <TraceTextSection title="Prompt" text={trace.prompt || '(not available)'} />

          <section className="trace-section">
            <div className="trace-section-heading">
              <h3>Timeline</h3>
              <span>{trace.timeline.length} items</span>
            </div>
            <div className="trace-timeline">
              {trace.timeline.map((event) => (
                <details className="trace-event" key={event.id}>
                  <summary>
                    <span className="trace-event-index">{event.index}</span>
                    <span className="trace-event-label">{event.label}</span>
                    <span className="trace-event-type">{event.type}</span>
                    {event.status ? <span className={`trace-event-status is-${event.status}`}>{event.status}</span> : null}
                    {event.durationMs !== null && event.durationMs !== undefined ? (
                      <span className="trace-event-duration">{formatDuration(event.durationMs)}</span>
                    ) : null}
                  </summary>
                  <div className="trace-event-body">
                    <div className="trace-event-time">
                      {event.startedAt ?? 'unknown start'} → {event.completedAt ?? 'in progress'}
                    </div>
                    <pre>{JSON.stringify(event.details, null, 2)}</pre>
                  </div>
                </details>
              ))}
            </div>
          </section>

          <TraceTextSection title="Final response" text={trace.finalResponse || '(not available yet)'} />
        </div>

        <footer className="trace-footer">
          <span>{actionStatus}</span>
          <code>{json.length.toLocaleString()} characters</code>
        </footer>
      </section>
    </div>
  )
}

function TraceMetric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="trace-metric">
      <span>{label}</span>
      <strong className={mono ? 'is-mono' : ''} title={value}>{value}</strong>
    </div>
  )
}

function TraceToken({ label, value }: { label: string; value: number | null | undefined }): React.JSX.Element {
  return (
    <div className="trace-token">
      <span>{label}</span>
      <strong>{typeof value === 'number' ? formatTokens(value) : '—'}</strong>
    </div>
  )
}

function TraceTextSection({ title, text }: { title: string; text: string }): React.JSX.Element {
  return (
    <section className="trace-section">
      <h3>{title}</h3>
      <pre className="trace-text">{text}</pre>
    </section>
  )
}

function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString()
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function formatDuration(value: number | undefined): string {
  if (typeof value !== 'number') return 'in progress'
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
