import { useEffect, useId, useRef, useState } from 'react'
import { LANDING_MEDIA } from './landing-media'

const DOWNLOAD_URL = 'https://github.com/chillysbabybackribs/codexdesktop/releases'

function PlayIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 7 5-7 5V7Z" fill="currentColor" /></svg>
}

function CloseIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}

function ExpandIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H5v4m10-4h4v4M5 15v4h4m10-4v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function SpeakerIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 3V7l-4 3H5Zm10.5.2a3 3 0 0 1 0 3.6m2-6a7 7 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function DesktopPoster(): React.JSX.Element {
  return <div className="desktop-poster" aria-hidden="true">
    <div className="poster-titlebar"><div className="poster-traffic"><i /><i /><i /></div><span>Codex Desktop</span><div /></div>
    <div className="poster-app">
      <aside className="poster-sidebar"><div className="poster-brand"><b>⌘</b><span>Codex</span></div><div className="poster-new">+&nbsp; New chat</div><p>RECENT</p><div className="poster-thread active">Landing page direction</div><div className="poster-thread">Browser research</div><div className="poster-thread">Review the diff</div><p>WORKSPACE</p><div className="poster-workspace"><span className="poster-dot" />codexdesktop</div></aside>
      <section className="poster-chat"><header><span>Landing page direction</span><em>Local</em></header><div className="poster-conversation"><div className="poster-you">Make the product demo the focal point and keep the page calm.</div><div className="poster-agent"><span className="poster-codex-mark">⌘</span><div><strong>Codex</strong><p>I’ll tighten the composition, preserve the app conventions, and verify it at every breakpoint.</p><div className="poster-task"><span>Editing landing.css</span><b /><b /><b /></div></div></div></div><div className="poster-composer"><span>Ask Codex to change this project</span><b>↑</b></div></section>
      <aside className="poster-browser"><div className="poster-browserbar"><span>⌕</span><div>localhost:5173/landing.html</div><b>⋯</b></div><div className="poster-browserpage"><div className="poster-browsernav"><span>Codex Desktop</span><i>Download</i></div><h3>Work with Codex<br />in one desktop app.</h3><div className="poster-browserline" /><div className="poster-browserline short" /></div></aside>
    </div>
  </div>
}

function DemoMedia(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const hasVideo = LANDING_MEDIA.sources.length > 0

  const close = () => {
    setOpen(false)
    setPlaying(false)
  }

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])') ?? [])
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = focusable()
      if (!nodes.length) {
        event.preventDefault()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
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

  const poster = LANDING_MEDIA.poster
    ? <img src={LANDING_MEDIA.poster} alt="Codex Desktop app session" />
    : <DesktopPoster />

  return <>
    <div className="demo-shell" id="demo">
      <button className="demo-trigger" type="button" ref={triggerRef} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Open the Codex Desktop product demo">
        {poster}
        <span className="demo-scrim" />
        <span className="demo-play"><PlayIcon /></span>
        <span className="demo-controls" aria-hidden="true"><PlayIcon /><span className="demo-progress"><i /></span><time>00:00 / {LANDING_MEDIA.durationLabel}</time><SpeakerIcon /><ExpandIcon /></span>
      </button>
    </div>

    {open && <div className="media-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="media-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="media-dialog-header"><div><span className="eyebrow">Product demo</span><h2 id={titleId}>Codex Desktop in action</h2></div><button ref={closeRef} className="dialog-close" type="button" onClick={close} aria-label="Close product demo"><CloseIcon /></button></div>
        <div className="modal-media">
          {hasVideo ? <video controls autoPlay playsInline poster={LANDING_MEDIA.poster} tabIndex={0}>{LANDING_MEDIA.sources.map((source) => <source key={source.src} src={source.src} type={source.type} />)}Your browser does not support the video element.</video> : <><DesktopPoster /><button className="modal-play" type="button" onClick={() => setPlaying((value) => !value)} aria-pressed={playing}><PlayIcon />{playing ? 'Pause placeholder' : 'Play placeholder'}</button>{playing && <span className="preview-status" role="status">Demo recording placeholder</span>}</>}
        </div>
        <p className="modal-note" id={descriptionId}>{hasVideo ? 'Use the video controls to play, mute, seek, or enter fullscreen.' : 'Add local MP4 or WebM sources in landing-media.ts to enable the final recording.'}</p>
      </div>
    </div>}
  </>
}

export function LandingPage(): React.JSX.Element {
  return <div className="landing-page">
    <header className="site-header"><a className="wordmark" href="#top" aria-label="Codex Desktop home"><span>⌘</span>Codex Desktop</a><a className="header-download" href={DOWNLOAD_URL}>Download <span aria-hidden="true">↗</span></a></header>
    <main>
      <section className="hero" id="top" aria-labelledby="hero-title"><div className="hero-copy"><p className="eyebrow">A desktop home for Codex</p><h1 id="hero-title">Work with Codex in one desktop app.</h1><p className="hero-summary">Keep the conversation beside the files, tools, and browser context the work depends on.</p><div className="hero-actions"><a className="primary-action" href={DOWNLOAD_URL}>Get Codex Desktop <span aria-hidden="true">→</span></a><a className="secondary-action" href="#demo">Watch the demo <span aria-hidden="true">↓</span></a></div></div><DemoMedia /></section>
      <section className="supporting-section" id="workspace" aria-labelledby="support-title"><p className="eyebrow">One focused workspace</p><h2 id="support-title">Keep the work in view.</h2><p>Codex Desktop keeps the conversation beside the context it needs: your files, tools, browser, and the work already in progress.</p></section>
    </main>
  </div>
}
