import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import InteractiveVideo from './InteractiveVideo.jsx';
import './styles.css';

const capabilities = [
  { key: 'browser', number: '01', title: 'See where it goes.', body: 'Goldenboy works inside the same logged-in browser you can see.', art: 'browser' },
  { key: 'undo', number: '02', title: 'Undo the wrong turn.', body: 'Every file edit and shell write is reversible at the turn boundary.', art: 'undo' },
  { key: 'review', number: '03', title: 'Bring a second opinion.', body: 'A second model can inspect the real worktree before anything ships.', art: 'review' },
];

function Mark() {
  return <span className="mark" aria-hidden="true"><i /><b /></span>;
}

function Logo() {
  return <a className="logo" href="#top" aria-label="Goldenboy home"><Mark /><span>GOLDENBOY</span></a>;
}

function Art({ type }) {
  if (type === 'browser') return <div className="mini browser-mini"><div className="mini-bar"><i /><i /><i /><span>neon.com</span></div><div className="mini-page"><b /><b /><b /><b /></div></div>;
  if (type === 'runtimes') return <div className="mini runtime-mini"><span>CODEX</span><i>↔</i><span>CLAUDE</span><small>one session contract</small></div>;
  if (type === 'undo') return <div className="mini undo-mini"><div><span>turn checkpoint</span><b>+ 8</b><em>− 2</em></div><span className="mini-button">Undo turn</span></div>;
  if (type === 'review') return <div className="mini review-mini"><div><i>DOER</i><span>Implementation complete</span></div><div><i>REVIEWER</i><span>✓ pass · 4 checks</span></div></div>;
  return <div className="mini panes-mini"><i /><i /><i /><i /></div>;
}

function ProductWindow({ mode = 'browser' }) {
  const copy = mode === 'checkpoint'
    ? { label: 'Checkpoint · turn 42', title: 'Every write is reversible.', body: 'A hidden git ref captures the real worktree without touching your branch.', side: ['App.tsx', 'styles.css', 'browser-agent.ts'] }
    : mode === 'review'
      ? { label: 'Audit loop · round 2 of 3', title: 'Different models. Shared evidence.', body: 'The reviewer reads the actual diff, then sends a concrete correction back to the doer.', side: ['VERDICT: pass', 'Tests clean', 'No P1 findings'] }
      : { label: 'Browser · authenticated profile', title: 'The web is part of the workspace.', body: 'Inspect, navigate, capture, and research inside the Chromium surface that stays with you.', side: ['Snapshot', 'Network', 'Web Vitals'] };

  return (
    <div className={`product-window ${mode}`} aria-label={`${copy.title} product preview`}>
      <div className="window-top"><div className="traffic"><i /><i /><i /></div><span>Goldenboy · local workstation</span><div className="window-actions"><i /><i /></div></div>
      <div className="window-body">
        <aside>
          <div className="thread active"><span>01</span><b>Map the release</b></div>
          <div className="thread"><span>02</span><b>Check the route</b></div>
          <div className="thread"><span>03</span><b>Research launch targets</b></div>
          <div className="dock-label">SHOTGUN CREW</div>
          <div className="agent"><i>C</i><span><b>Reviewer</b><small>checking · round 2</small></span></div>
          <div className="agent"><i>A</i><span><b>Scout</b><small>browser research</small></span></div>
        </aside>
        <div className="window-main">
          <div className="surface-head"><span>{copy.label}</span><b>•••</b></div>
          <div className="surface-content">
            <p className="eyebrow">LIVE WORKSPACE</p>
            <h3>{copy.title}</h3>
            <p>{copy.body}</p>
            <div className="surface-code">
              <span><i>01</i>await browser.snapshot(objective)</span>
              <span><i>02</i>checkpoint.capture(worktree)</span>
              <span><i>03</i>reviewer.audit(diff)</span>
            </div>
          </div>
        </div>
        <section className="inspector">
          <span>TRACE</span>
          {copy.side.map((item, index) => <div key={item}><i>{String(index + 1).padStart(2, '0')}</i><b>{item}</b></div>)}
          <div className="pulse"><i /><span>live</span></div>
        </section>
      </div>
    </div>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [story, setStory] = useState('browser');
  const [copied, setCopied] = useState(false);
  const menuButton = useRef(null);

  useEffect(() => {
    document.body.classList.toggle('menu-open', menuOpen);
    return () => document.body.classList.remove('menu-open');
  }, [menuOpen]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const copyCommand = async () => {
    await navigator.clipboard?.writeText('npm run dev');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      <header className="site-header" id="top">
        <Logo />
        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#interactive-demo">The ride</a>
          <a href="#primitives">The workstation</a>
          <a href="#architecture">Under the hood</a>
        </nav>
        <div className="header-actions"><a className="quiet" href="#architecture">How it works</a><a className="button light small" href="#interactive-demo">Take the wheel</a></div>
        <button ref={menuButton} className={`menu-toggle ${menuOpen ? 'open' : ''}`} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><i /><i /></button>
      </header>

      {menuOpen && <div className="mobile-menu" role="dialog" aria-modal="true" aria-label="Mobile navigation">
        <nav>
          <a href="#interactive-demo" onClick={() => setMenuOpen(false)}>The ride<span>01</span></a>
          <a href="#primitives" onClick={() => setMenuOpen(false)}>The workstation<span>02</span></a>
          <a href="#architecture" onClick={() => setMenuOpen(false)}>Under the hood<span>03</span></a>
        </nav>
        <div><a className="button outline" href="#architecture" onClick={() => setMenuOpen(false)}>How it works</a><a className="button light" href="#interactive-demo" onClick={() => setMenuOpen(false)}>Take the wheel</a></div>
      </div>}

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-media" aria-hidden="true">
            <picture>
              <source srcSet="/media/goldenboy-shotgun-hero-warm-tint.webp" type="image/webp" />
              <img className="hero-photo" src="/media/goldenboy-shotgun-hero-warm-tint.png" alt="" />
            </picture>
            <div className="hero-media-fade" />
          </div>
          <div className="hero-content">
            <p className="kicker"><Mark /> HUMAN IN THE DRIVER'S SEAT</p>
            <h1 id="hero-title">Drive your browser with a model <em>riding shotgun.</em></h1>
            <p className="hero-deck">Goldenboy is a local agent workstation for the code and the web. You choose the destination; it handles the research, changes, and checks while you keep your hands on the wheel.</p>
            <div className="hero-actions"><a className="button light" href="#interactive-demo">Watch the drive</a><a className="button outline" href="#primitives">See the workstation</a></div>
          </div>
          <div className="capability-wrap">
            <div className="capability-strip" role="region" tabIndex="0" aria-label="Core capabilities" aria-describedby="capability-rail-hint">
              {capabilities.map(item => <article key={item.key}><span className="route-number">{item.number}</span><p><b>{item.title}</b> <span>{item.body}</span></p><Art type={item.art} /></article>)}
            </div>
            <p className="rail-hint" id="capability-rail-hint">Swipe the route →</p>
          </div>
        </section>

        <div className="substrate" aria-label="Goldenboy operating principles"><span>BROWSER IN VIEW</span><span>WORKTREE LOCAL</span><span>EVERY TURN REVERSIBLE</span><span>MODEL CHOICE</span></div>

        <section className="interactive-story dark-section" id="interactive-demo" aria-labelledby="interactive-title">
          <div className="interactive-heading">
            <p className="mono-label">THE FIRST MILE</p>
            <div>
              <h2 id="interactive-title">Watch the passenger work.</h2>
              <p>This is not a looped sizzle reel. Pause the route, inspect a decision, zoom into the evidence, and decide where the work goes next.</p>
            </div>
          </div>
          <InteractiveVideo />
        </section>

        <section className="primitives dark-section" id="primitives">
          <div className="section-copy centered">
            <p className="mono-label">YOU STEER. IT HANDLES THE ROADWORK.</p>
            <h2>Give Goldenboy a destination. It can read the repo, work the browser, change the worktree, and show you exactly what happened.</h2>
          </div>
          <button className="command" onClick={copyCommand} aria-label="Copy npm run dev command"><span>$</span> npm run dev <b>{copied ? 'Copied' : 'Copy'}</b></button>
          <div className="story-tabs" role="tablist" aria-label="Product preview">
            {['browser', 'checkpoint', 'review'].map(name => <button role="tab" aria-selected={story === name} key={name} onClick={() => setStory(name)}>{name === 'browser' ? 'Browser' : name === 'checkpoint' ? 'Checkpoints' : 'Review loop'}</button>)}
          </div>
          <ProductWindow mode={story} />
        </section>

        <section className="browser-story mint-section">
          <div className="split-heading"><p className="mono-label dark">THE ROAD AHEAD</p><h2>A browser Goldenboy can actually see—and one you can watch. Logged in, visible, and never hidden behind a remote black box.</h2></div>
          <div className="browser-diagram">
            <div className="metric"><span>OBJECTIVE</span><strong>“Find the exact evidence”</strong></div>
            <div className="route"><i /><i /><i /><i /><i /><b>you set the destination</b></div>
            <div className="result-card"><span>SNAPSHOT RESULT</span><strong>answer</strong><p>Coverage complete · 6 exact passages</p></div>
          </div>
          <p className="section-footnote">The browser stays inside the same visible workstation, so the model's route is always inspectable.</p>
        </section>

        <section className="checkpoint-story dark-section">
          <div className="split-heading reverse"><p className="mono-label">WRONG TURN?</p><h2>Every turn leaves a way back. File edits, shell writes, and reversals all land in the same honest history.</h2></div>
          <div className="checkpoint-grid">
            <article><span>01</span><h3>Worktree ground truth</h3><p>Shell writes and file edits land in the same checkpoint history.</p><div className="line-map"><i /><i /><i /><i /><i /></div></article>
            <article><span>02</span><h3>Keep or undo</h3><p>Review the actual changed files, then keep a turn or roll it back.</p><div className="keep-row"><button>Keep</button><button>Undo</button></div></article>
            <article><span>03</span><h3>Undo the undo</h3><p>Reverts are checkpointed too, so recovery never becomes a one-way door.</p><div className="history-row"><i /><b /><i /><b /><i /></div></article>
          </div>
        </section>

        <section className="runtime-story dark-section" id="architecture">
          <div className="runtime-heading"><p className="mono-label">PICK YOUR MODEL</p><h2>Codex can take the task. Claude can check the map. You stay in charge of what ships.</h2></div>
          <div className="runtime-visual">
            <div className="provider codex"><span>DOER</span><strong>Codex</strong><p>Builds against the repo and browser.</p></div>
            <div className="contract"><i /><b>Goldenboy</b><small>one shared cockpit</small><i /></div>
            <div className="provider claude"><span>REVIEWER</span><strong>Claude</strong><p>Audits the shared worktree and evidence.</p></div>
          </div>
        </section>

        <section className="features dark-section">
          <div className="feature-heading"><h2>A model can take work off your plate <span>without taking your hands off the product.</span></h2></div>
          <div className="feature-grid">
            <article><i>◎</i><p><b>Visible by default.</b> Watch the browser, inspect the trace, and see the evidence behind a turn.</p></article>
            <article><i>⌘</i><p><b>Local by design.</b> Familiar files and the real worktree stay close instead of disappearing into a remote sandbox.</p></article>
            <article><i>↔</i><p><b>Model-agnostic.</b> Switch between Codex and Claude without learning a different workstation.</p></article>
            <article><i>↻</i><p><b>Built to stop.</b> Research and review continue only while the next pass is producing real evidence.</p></article>
          </div>
        </section>

        <section className="foundation mint-section">
          <div className="foundation-grid">
            <div><p className="mono-label dark"><span>▶</span> THE DEAL</p><h2>Goldenboy does the busy driving. You choose the destination, watch the road, and decide what ships.</h2><div className="foundation-stats"><article><Mark /><strong>2</strong><span>model runtimes</span></article><article><Mark /><strong>1–4</strong><span>live workspaces</span></article></div></div>
            <blockquote><p>The model can ride shotgun. It never gets the keys.</p><cite>Goldenboy operating principle</cite></blockquote>
          </div>
        </section>

        <section className="cta" id="cta">
          <div className="cta-grid" aria-hidden="true" />
          <h2>Take the driver's seat.</h2>
          <p>See Goldenboy navigate the browser, work the repo, and show its receipts.</p>
          <div><a className="button light" href="#interactive-demo">Watch the guided drive</a><a className="button outline" href="#primitives">Open the workstation</a></div>
        </section>
      </main>

      <footer className="site-footer"><Logo /><p>Working title · local prototype · built around Codex Desktop</p><a href="#top">Back to top ↑</a></footer>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
