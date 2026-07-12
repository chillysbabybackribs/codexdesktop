import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { LANDING_MEDIA, type LandingMediaConfig } from './landing-media'

const PRODUCT_LINKS = {
  download: 'https://github.com/chillysbabybackribs/codexdesktop/releases'
} as const

function PlayIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 7 7 5-7 5V7Z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 7h3v10H8V7Zm5 0h3v10h-3V7Z" fill="currentColor" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function FullscreenIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5H5v4m10-4h4v4M5 15v4h4m10-4v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SpeakerIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 10v4h3l4 3V7l-4 3H5Zm10.5.2a3 3 0 0 1 0 3.6m2-6a7 7 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CodexMark(): React.JSX.Element {
  return (
    <svg className="codex-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.4 5.2A7.7 7.7 0 0 1 19 8.1M15.6 18.8A7.7 7.7 0 0 1 5 15.9M5.2 8.4A7.7 7.7 0 0 1 8.1 5M18.8 15.6A7.7 7.7 0 0 1 15.9 19" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
    </svg>
  )
}

function DesktopSessionPoster(): React.JSX.Element {
  return (
    <div className="desktop-poster" aria-hidden="true">
      <div className="poster-titlebar">
        <div className="poster-traffic"><i /><i /><i /></div>
        <span>codexdesktop — Codex</span>
        <div className="poster-title-actions"><i /><i /></div>
      </div>

      <div className="poster-app">
        <aside className="poster-sidebar">
          <div className="poster-brand"><CodexMark /><span>Codex</span></div>
          <div className="poster-new"><span>＋</span> New task</div>
          <p>RECENT</p>
          <div className="poster-thread active"><span />Landing page polish</div>
          <div className="poster-thread"><span />Review media modal</div>
          <div className="poster-thread"><span />Responsive QA</div>
          <p>WORKSPACE</p>
          <div className="poster-workspace"><span className="poster-workspace-dot" />codexdesktop</div>
        </aside>

        <section className="poster-chat">
          <header>
            <div><strong>Landing page polish</strong><span>codexdesktop</span></div>
            <em>Local</em>
          </header>
          <div className="poster-conversation">
            <div className="poster-user-message">Make the product demo the focal point and keep the page calm.</div>
            <div className="poster-agent-message">
              <CodexMark />
              <div>
                <strong>Codex</strong>
                <p>I’ll tighten the composition, preserve the app conventions, and verify the modal at each breakpoint.</p>
                <div className="poster-activity">
                  <span className="poster-status-dot" />
                  <span>Editing landing.css</span>
                  <time>12s</time>
                </div>
                <div className="poster-file-change"><b>+38</b><b>−21</b><span>src/renderer/src/landing.css</span></div>
              </div>
            </div>
          </div>
          <div className="poster-composer"><span>Ask Codex to change this project</span><b>↑</b></div>
        </section>

        <aside className="poster-browser">
          <div className="poster-browserbar"><span>‹</span><span>›</span><div>localhost:5173/landing.html</div><b>•••</b></div>
          <div className="poster-browserpage">
            <div className="poster-browsernav"><span>Codex Desktop</span><i>Download</i></div>
            <div className="poster-browserhero">
              <small>CODEX DESKTOP</small>
              <h3>Work with Codex in one desktop app.</h3>
              <p>Files, tools, and browser context stay in view.</p>
              <span>Get Codex Desktop →</span>
            </div>
            <div className="poster-browsermedia"><i /></div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function MediaPoster({ config }: { config: LandingMediaConfig }): React.JSX.Element {
  if (config.poster) {
    return <img className="demo-poster-image" src={config.poster} alt="Codex Desktop app session" />
  }

  return <DesktopSessionPoster />
}

function DemoMedia({ config }: { config: LandingMediaConfig }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [placeholderPlaying, setPlaceholderPlaying] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const hasVideo = config.sources.length > 0

  const closeDialog = () => {
    setOpen(false)
    setPlaceholderPlaying(false)
  }

  useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const getFocusableElements = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => !element.hasAttribute('hidden'))

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDialog()
        return
      }

      if (event.key !== 'Tab') return

      const focusableElements = getFocusableElements()
      if (focusableElements.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeydown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeydown)
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [open])

  return (
    <>
      <div className="demo-shell" id="demo">
        <button
          className="demo-trigger"
          type="button"
          ref={triggerRef}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label="Open the Codex Desktop product demo"
        >
          <MediaPoster config={config} />
          <span className="demo-play"><PlayIcon /></span>
          <span className="demo-controls" aria-hidden="true">
            <PlayIcon />
            <span className="demo-progress"><i /></span>
            <time>00:00 / {config.durationLabel}</time>
            <SpeakerIcon />
            <FullscreenIcon />
          </span>
        </button>
      </div>

      {open && (
        <div
          className="media-dialog-backdrop"
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) closeDialog()
          }}
        >
          <div
            className="media-dialog"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
          >
            <div className="media-dialog-header">
              <div>
                <span className="eyebrow eyebrow-dark">Product demo</span>
                <h2 id={titleId}>Codex Desktop in action</h2>
              </div>
              <button ref={closeRef} className="dialog-close" type="button" onClick={closeDialog} aria-label="Close product demo">
                <CloseIcon />
              </button>
            </div>

            <div className="modal-media">
              {hasVideo ? (
                <video controls autoPlay playsInline poster={config.poster} tabIndex={0}>
                  {config.sources.map((source) => <source key={source.src} src={source.src} type={source.type} />)}
                  Your browser does not support the video element.
                </video>
              ) : (
                <>
                  <DesktopSessionPoster />
                  <button
                    className="modal-play"
                    type="button"
                    onClick={() => setPlaceholderPlaying((value) => !value)}
                    aria-pressed={placeholderPlaying}
                  >
                    {placeholderPlaying ? <PauseIcon /> : <PlayIcon />}
                    {placeholderPlaying ? 'Pause placeholder' : 'Play placeholder'}
                  </button>
                  {placeholderPlaying && <span className="preview-status" role="status">Demo recording placeholder</span>}
                </>
              )}
            </div>

            <p className="modal-note" id={descriptionId}>
              {hasVideo
                ? 'Use the video controls to play, mute, seek, or enter fullscreen.'
                : 'Add local MP4 or WebM sources in landing-media.ts to enable the final recording.'}
            </p>
          </div>
        </div>
      )}
    </>
  )
}

export function LandingPage(): React.JSX.Element {
  return (
    <div className="landing-page">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Codex Desktop home">Codex Desktop</a>
        <a className="header-download" href={PRODUCT_LINKS.download}>Download <span aria-hidden="true">↗</span></a>
      </header>

      <main>
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="hero-heading">
              <p className="eyebrow">Codex Desktop</p>
              <h1 id="hero-title">Work with Codex in one desktop app.</h1>
            </div>
            <div className="hero-intro">
              <p className="hero-summary">Keep the conversation beside the files, tools, and browser context the work depends on.</p>
              <div className="hero-actions">
                <a className="primary-action" href={PRODUCT_LINKS.download}>Get Codex Desktop <span aria-hidden="true">→</span></a>
                <a className="secondary-action" href="#demo">Watch the demo <span aria-hidden="true">↓</span></a>
              </div>
            </div>
          </div>

          <DemoMedia config={LANDING_MEDIA} />
        </section>

        <section className="supporting-section" id="workspace" aria-labelledby="support-title">
          <div className="supporting-heading">
            <p className="eyebrow">One focused workspace</p>
            <h2 id="support-title">Keep the work in view.</h2>
          </div>
          <div className="supporting-copy">
            <p><strong>Work with the project.</strong> Open files and changes stay close to the conversation.</p>
            <p><strong>Use the tools you need.</strong> Terminal actions and task progress remain visible.</p>
            <p><strong>Bring in the web.</strong> Browser context sits beside the work instead of in another window.</p>
          </div>
        </section>
      </main>
    </div>
  )
}
