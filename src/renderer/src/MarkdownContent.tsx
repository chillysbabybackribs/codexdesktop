import { Children, isValidElement, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { classifyMarkdownHref } from './markdown-link'
import { chunkMarkdownSegments, splitMarkdownSegments } from './streaming-markdown'

type ChartDatum = {
  label: string
  value: number
  color?: string
}

type ChartConfig = {
  type?: 'bar' | 'line' | 'horizontal-bar'
  title?: string
  description?: string
  unit?: string
  color?: string
  data?: ChartDatum[]
  labels?: string[]
  values?: number[]
}

export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

const MarkdownFragment = memo(function MarkdownFragment({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  )
})

// Streaming variant: the document is split into stable segments so each delta
// re-parses only the trailing segment instead of the whole message. Callers
// must switch to MarkdownContent once the item completes — the single parse is
// the fidelity guarantee for segment-boundary edge cases.
export const StreamingMarkdownContent = memo(function StreamingMarkdownContent({
  text
}: {
  text: string
}): React.JSX.Element {
  const segments = chunkMarkdownSegments(splitMarkdownSegments(text))
  return (
    <div className="markdown-body">
      {segments.map((segment, index) => (
        <MarkdownFragment key={index} text={segment} />
      ))}
    </div>
  )
})

export const BrowserMarkdownLink: NonNullable<Components['a']> = ({ children, href, node: _node, ...props }) => (
  <a
    {...props}
    href={href}
    onClick={(event) => {
      const destination = classifyMarkdownHref(href)
      if (destination === 'anchor') return

      event.preventDefault()
      if (destination === 'browser' && href) void window.api.browser.newTab(href)
    }}
  >
    {children}
  </a>
)

export const browserLinkComponents: Components = { a: BrowserMarkdownLink }

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="markdown-title">{children}</h1>,
  h2: ({ children }) => <h2 className="markdown-section-title">{children}</h2>,
  h3: ({ children }) => <h3 className="markdown-subtitle">{children}</h3>,
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  blockquote: ({ children }) => <blockquote className="markdown-quote">{children}</blockquote>,
  hr: () => <hr className="markdown-rule" />,
  a: BrowserMarkdownLink,
  pre: ({ children, ...props }) => {
    const child = Children.toArray(children)[0]
    if (isValidElement(child) && child.type === ChartBlock) return child
    return <pre {...props}>{children}</pre>
  },
  code: ({ children, className, ...props }) => {
    const language = className?.match(/language-([\w-]+)/)?.[1]
    const value = String(children).replace(/\n$/, '')
    const config = language === 'chart' || language === 'graph' ? parseChartConfig(value) : null

    if (config) return <ChartBlock config={config} />

    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }
}

function parseChartConfig(value: string): ChartConfig | null {
  try {
    const parsed = JSON.parse(value) as ChartConfig
    const data = parsed.data ?? parsed.labels?.map((label, index) => ({
      label,
      value: parsed.values?.[index] ?? 0
    }))

    if (!data?.length || data.some((datum) => !datum.label || !Number.isFinite(datum.value))) return null
    return { ...parsed, type: parsed.type ?? 'bar', data }
  } catch {
    return null
  }
}

function ChartBlock({ config }: { config: ChartConfig }): React.JSX.Element {
  const data = config.data ?? []
  const max = Math.max(...data.map((datum) => Math.abs(datum.value)), 1)
  const min = Math.min(...data.map((datum) => datum.value), 0)
  const range = Math.max(max - min, 1)
  const chartType = config.type ?? 'bar'
  const formatValue = (value: number): string => `${value}${config.unit ?? ''}`

  if (chartType === 'line') {
    const points = data.map((datum, index) => {
      const x = data.length === 1 ? 50 : (index / (data.length - 1)) * 100
      const y = 100 - ((datum.value - min) / range) * 100
      return `${x},${Math.max(4, Math.min(96, y))}`
    }).join(' ')

    return (
      <figure className="markdown-chart" aria-label={config.title ?? 'Line chart'}>
        {config.title ? <figcaption className="markdown-chart-title">{config.title}</figcaption> : null}
        {config.description ? <p className="markdown-chart-description">{config.description}</p> : null}
        <div className="markdown-line-chart">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-hidden="true">
            <path className="markdown-chart-gridline" d="M0 25H100M0 50H100M0 75H100" />
            <polyline className="markdown-chart-line" points={points} />
          </svg>
          <div className="markdown-line-points">
            {data.map((datum, index) => (
              <div className="markdown-line-point" key={`${datum.label}-${index}`}>
                <strong>{formatValue(datum.value)}</strong>
                <span>{datum.label}</span>
              </div>
            ))}
          </div>
        </div>
      </figure>
    )
  }

  return (
    <figure className={`markdown-chart is-${chartType}`} aria-label={config.title ?? 'Bar chart'}>
      {config.title ? <figcaption className="markdown-chart-title">{config.title}</figcaption> : null}
      {config.description ? <p className="markdown-chart-description">{config.description}</p> : null}
      <div className="markdown-bar-chart">
        {data.map((datum, index) => {
          const size = chartType === 'horizontal-bar'
            ? (Math.abs(datum.value) / max) * 100
            : ((datum.value - min) / range) * 100
          return (
            <div className="markdown-bar-item" key={`${datum.label}-${index}`}>
              <div className="markdown-bar-track">
                <div
                  className="markdown-bar-fill"
                  style={{
                    [chartType === 'horizontal-bar' ? 'width' : 'height']: `${Math.max(size, 3)}%`,
                    background: datum.color ?? config.color
                  }}
                >
                  <span>{formatValue(datum.value)}</span>
                </div>
              </div>
              <span className="markdown-bar-label">{datum.label}</span>
            </div>
          )
        })}
      </div>
    </figure>
  )
}
