import { useEffect, useId, useRef, useState } from 'react'

type MediaConfig = {
  /** Set this to a local .mp4/.webm URL when a recording is ready. */
  src?: string
  /** Replace with a real still image if preferred. The current poster is code-native. */
  poster?: string
  duration: string
}

// Media replacement boundary: update only this object when the launch recording is ready.
const heroMedia: MediaConfig = {
  src: undefined,
  poster: undefined,
  duration: '01:18'
}

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
      <section className="poster-chat"><header><span>Landing page direction</span><em>GPT-5</em></header><div className="poster-conversation"><div className="poster-you">Build a clean landing page for the desktop app. Keep the product demo central.</div><div className="poster-agent"><span className="poster-codex-mark">⌘</span><div><strong>Codex</strong><p>I’ll create a focused page with a reusable media surface and inspect it at every breakpoint.</p><div className="poster-task"><span>Working</span><b /><b /><b /></div></div></div></div><div className="poster-composer"><span>Ask Codex anything</span><b>↑</b></div></section>
      <aside className="poster-browser"><div className="poster-browserbar"><span>⌕</span><div>localhost:5173</div><b>⋯</b></div><div className="poster-browserpage"><div className="poster-browsernav"><span>Codex Desktop</span><i>Download</i></div><h3>Work with Codex,<br />without leaving your desk.</h3><div className="poster-browserline" /><div className="poster-browserline short" /></div></aside>
    </div>
  </div>
}

function DemoMedia(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const close = () => {
    setOpen(false)
    setPlaying(false)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], video, [tabindex]:not([tabindex="-1"])') ?? []).filter((node) => !node.hasAttribute('disabled'))
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key !== 'Tab') return
      const nodes = focusable()
      if (!nodes.length) { event.preventDefault(); return }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeydown)
    const timer = window.setTimeout(() => focusable()[0]?.focus(), 0)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKeydown); window.clearTimeout(timer) }
  }, [open])

  const poster = <DesktopPoster />
  return <>
    <div className="demo-shell">
      <button className="demo-trigger" type="button" ref={triggerRef} onClick={() => setOpen(true)} aria-label="Open the Codex Desktop preview">
        {heroMedia.poster ? <img src={heroMedia.poster} alt="Codex Desktop preview" /> : poster}
        <span className="demo-scrim" />
        <span className="demo-play"><PlayIcon /></span>
        <span className="demo-controls" aria-hidden="true"><PlayIcon /><span className="demo-progress"><i /></span><time>00:00 / {heroMedia.duration}</time><SpeakerIcon /><ExpandIcon /></span>
      </button>
    </div>
    {open && <div className="media-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="media-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="media-dialog-header"><div><span className="eyebrow">Product preview</span><h2 id={titleId}>Codex Desktop in action</h2></div><button className="dialog-close" type="button" onClick={close} aria-label="Close preview"><CloseIcon /></button></div>
        <div className="modal-media">
          {heroMedia.src ? <video controls autoPlay poster={heroMedia.poster} src={heroMedia.src}>Your browser does not support the video tag.</video> : <><DesktopPoster /><button className="modal-play" type="button" onClick={() => setPlaying((value) => !value)} aria-pressed={playing}><PlayIcon />{playing ? 'Pause preview' : 'Play preview'}</button>{playing && <span className="preview-status">Preview placeholder</span>}</>}
        </div>
        {!heroMedia.src && <p className="modal-note">This is a visual placeholder. Add a recording in <code>heroMedia</code> to enable playback.</p>}
      </div>
    </div>}
  </>
}

export function LandingPage(): React.JSX.Element {
  return <main className="landing-page">
    <header className="site-header"><a className="wordmark" href="#top" aria-label="Codex Desktop home"><span>⌘</span>Codex Desktop</a><a className="header-download" href="#download">Download <span aria-hidden="true">↗</span></a></header>
    <section className="hero" id="top" aria-labelledby="hero-title"><div className="hero-copy"><p className="eyebrow">A desktop home for Codex</p><h1 id="hero-title">A better place to work with Codex.</h1><p className="hero-summary">Bring your conversations, tools, files, and browser context into one calm desktop workspace.</p><div className="hero-actions"><a className="primary-action" id="download" href="#get-codex">Get Codex Desktop <span aria-hidden="true">→</span></a><a className="secondary-action" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a></div></div><DemoMedia /></section>
    <section className="supporting-section" id="how-it-works" aria-labelledby="support-title"><p className="eyebrow">One focused workspace</p><h2 id="support-title">Keep the work in view.</h2><p>Codex Desktop keeps the conversation beside the context it needs: your files, the browser, and the work already in progress.</p></section>
  </main>
}
