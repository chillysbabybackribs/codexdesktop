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
  const truncations = trace.capture.truncations ?? []
  const structuredToolCallCount = trace.summary.structuredToolCallCount ?? trace.summary.toolCallCount ?? 0
  const searchEventCount = trace.summary.searchEventCount ?? trace.summary.searchCount ?? 0
  const executionCount = trace.summary.executionCount ??
    trace.summary.commandCount + structuredToolCallCount + searchEventCount
  const failedCommandCount = trace.summary.failedCommandCount ?? 0
  const accounting = trace.usage.accounting
  const modelCalls = trace.usage.modelCalls ?? []
  const droppedModelCallSamples = trace.usage.droppedModelCallSamples ?? 0

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
              <strong>{truncations.length && !trace.capture.missing.length ? 'Bounded trace' : 'Partial trace'}</strong>
              <div className="trace-capture-copy">
                {trace.capture.missing.length ? (
                  <span>Missing: {trace.capture.missing.join(', ')}.</span>
                ) : null}
                {truncations.length ? (
                  <span>
                    {truncations.length} {truncations.length === 1 ? 'field was' : 'fields were'} size-limited or omitted:
                    {' '}{truncations.map((entry) => entry.path).join(', ')}.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <section className="trace-summary-grid">
            <TraceMetric label="Status" value={trace.turn.status} />
            <TraceMetric label="Duration" value={formatDuration(trace.turn.durationMs)} />
            <TraceMetric label="Model" value={trace.environment.model ?? 'unknown'} />
            <TraceMetric label="Reasoning" value={trace.environment.reasoningEffort ?? 'unknown'} />
            <TraceMetric label="Model calls" value={String(trace.usage.modelCallCount)} />
            <TraceMetric label="Executions" value={String(executionCount)} />
            <TraceMetric label="Commands" value={String(trace.summary.commandCount)} />
            <TraceMetric label="Structured tools" value={String(structuredToolCallCount)} />
            <TraceMetric label="Search events" value={String(searchEventCount)} />
            <TraceMetric label="Browser tools" value={String(trace.summary.browserToolCount)} />
            <TraceMetric label="Failed commands" value={String(failedCommandCount)} />
          </section>
          <p className="trace-accounting-note">
            Executions count shell commands, structured tool calls, and structured search events.
            Network or search work performed inside a shell command remains part of that command.
          </p>

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
              <TraceToken label="Uncached" value={accounting?.uncachedInputTokens} />
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
                {accounting?.cachedInputPercent !== null && accounting?.cachedInputPercent !== undefined
                  ? ` Cache rate: ${accounting.cachedInputPercent.toFixed(1)}%.`
                  : ''}
                {accounting?.latestCallContextPercent !== null && accounting?.latestCallContextPercent !== undefined
                  ? ` Latest-call context: ${accounting.latestCallContextPercent.toFixed(1)}%.`
                  : ''}
              </p>
            ) : null}
            <p className="trace-usage-note">
              Turn total is accumulated consumption across model calls; latest call is one request;
              thread total is the cumulative counter snapshot at completion.
            </p>
          </section>

          {modelCalls.length ? (
            <section className="trace-section">
              <div className="trace-section-heading">
                <h3>Context growth</h3>
                <span>
                  {modelCalls.length} retained {modelCalls.length === 1 ? 'sample' : 'samples'}
                  {droppedModelCallSamples ? ` · ${droppedModelCallSamples} older dropped` : ''}
                </span>
              </div>
              <div className="trace-call-table-wrap">
                <table className="trace-call-table">
                  <thead>
                    <tr>
                      <th>Call</th>
                      <th>Input</th>
                      <th>Cache</th>
                      <th>Context</th>
                      <th>Delta</th>
                      <th>Preceded by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelCalls.map((sample) => (
                      <tr key={sample.sequence} className={sample.compactedBeforeCall ? 'is-compacted' : ''}>
                        <td>
                          <strong>#{sample.sequence}</strong>
                          <span>{formatCallTime(sample.atMs)}</span>
                          {sample.compactedBeforeCall ? <em>compacted</em> : null}
                        </td>
                        <td>
                          <strong>{formatTokens(sample.usage.inputTokens)}</strong>
                          <div className="trace-call-bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, sample.contextPercent ?? 0)}%` }} />
                          </div>
                        </td>
                        <td>
                          <strong>{formatTokens(sample.usage.cachedInputTokens)} cached</strong>
                          <span>{formatTokens(sample.uncachedInputTokens)} uncached</span>
                        </td>
                        <td>
                          <strong>{sample.contextPercent === null ? 'unknown' : `${sample.contextPercent.toFixed(1)}%`}</strong>
                          <span>{sample.contextWindow ? `of ${formatTokens(sample.contextWindow)}` : 'window unknown'}</span>
                        </td>
                        <td>
                          <strong>{formatSignedTokens(sample.inputDeltaFromPrevious)}</strong>
                        </td>
                        <td>
                          {sample.precedingItem ? (
                            <>
                              <strong>{sample.precedingItem.label}</strong>
                              <code title={sample.precedingItem.itemId}>{sample.precedingItem.itemType}</code>
                              <span>
                                {formatChars(sample.precedingItem.argumentChars)} args ·{' '}
                                {formatChars(sample.precedingItem.resultChars)} result
                              </span>
                            </>
                          ) : <span>unknown</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {trace.goal ? (
            <section className="trace-section trace-goal">
              <div className="trace-section-heading">
                <h3>Goal lifecycle</h3>
                <span>
                  {trace.goal.statusAtStart ?? 'none'} → {trace.goal.statusAtEnd ?? 'cleared'}
                </span>
              </div>
              <p className="trace-goal-objective">{trace.goal.objective}</p>
              <div className="trace-token-row">
                <TraceToken label="Budget" value={trace.goal.tokenBudget} />
                <TraceToken label="Tokens used" value={trace.goal.tokensUsedAtEnd} />
                <TraceToken label="Turn delta" value={trace.goal.tokensUsedDelta} />
                <TraceMetric
                  label="Continuation"
                  value={trace.goal.continuation
                    ? trace.goal.continuationInferred ? 'yes, inferred' : 'yes'
                    : 'no'}
                />
              </div>
              <div className="trace-goal-evidence">
                <span>Observed completion evidence</span>
                <strong>{trace.goal.observedCompletionEvidence.citationCount} citations</strong>
                <strong>{trace.goal.observedCompletionEvidence.artifactCount} artifacts</strong>
                <strong>{trace.goal.observedCompletionEvidence.successfulCommandCount} successful commands</strong>
                <strong>{trace.goal.observedCompletionEvidence.successfulStructuredToolCount} successful tools</strong>
                <strong>{trace.goal.observedCompletionEvidence.fileChangeCount} file changes</strong>
              </div>
              <p className="trace-usage-note">
                Completion claimed: {trace.goal.completionClaimed ? 'yes' : 'no'}.
                These are observed execution signals, not proof that the objective was satisfied.
              </p>
            </section>
          ) : null}

          {trace.timing ? (
            <section className="trace-section">
              <div className="trace-section-heading">
                <h3>Timing coverage</h3>
                <span>{trace.timing.timedEventCount} timed event spans</span>
              </div>
              <div className="trace-token-row trace-timing-row">
                <TraceMetric label="Wall time" value={formatDuration(trace.timing.wallDurationMs ?? undefined)} />
                <TraceMetric label="Attributed" value={formatDuration(trace.timing.attributedDurationMs)} />
                <TraceMetric label="Unattributed" value={formatDuration(trace.timing.unattributedDurationMs ?? undefined)} />
                <TraceMetric
                  label="Coverage"
                  value={trace.timing.attributionPercent === null ? 'unknown' : `${trace.timing.attributionPercent.toFixed(1)}%`}
                />
              </div>
              <p className="trace-usage-note">
                Attributed time is the overlap-adjusted union of visible event spans. Unattributed time is waiting or work
                for which the app server did not expose a timed event.
              </p>
            </section>
          ) : null}

          <section className="trace-section trace-identifiers">
            <h3>Identity</h3>
            <dl>
              <dt>Thread</dt><dd>{trace.thread.id ?? 'not assigned'}</dd>
              <dt>Turn</dt><dd>{trace.turn.id}</dd>
              <dt>Workspace</dt><dd>{trace.environment.workspace ?? 'default'}</dd>
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

          {trace.sourceIndex?.items.length ? (
            <section className="trace-section">
              <div className="trace-section-heading">
                <h3>Sources cited</h3>
                <span>{trace.sourceIndex.items.length} final-response citations</span>
              </div>
              <div className="trace-index-list">
                {trace.sourceIndex.items.map((source) => (
                  <div className="trace-index-item" key={source.url}>
                    <span className={`trace-index-kind is-${source.kind}`}>{source.kind}</span>
                    <strong>{source.label}</strong>
                    <code>{source.url}</code>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {trace.artifactIndex?.items.length ? (
            <section className="trace-section">
              <div className="trace-section-heading">
                <h3>Artifacts</h3>
                <span>{trace.artifactIndex.items.length} paths observed in turn events</span>
              </div>
              <div className="trace-index-list">
                {trace.artifactIndex.items.map((artifact) => (
                  <div className="trace-index-item" key={`${artifact.originEventId}:${artifact.path}`}>
                    <span className="trace-index-kind">{artifact.kind}</span>
                    <code>{artifact.path}</code>
                  </div>
                ))}
              </div>
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

export function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString()
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function formatSignedTokens(value: number | null): string {
  if (value === null) return 'baseline'
  if (value === 0) return 'no change'
  return `${value > 0 ? '+' : '−'}${formatTokens(Math.abs(value))}`
}

function formatChars(value: number | null): string {
  return value === null ? '—' : `${formatTokens(value)} chars`
}

function formatCallTime(value: number | null): string {
  return value === null ? 'time unknown' : new Date(value).toLocaleTimeString()
}

function formatDuration(value: number | undefined): string {
  if (typeof value !== 'number') return 'in progress'
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
