import React, { useEffect, useMemo, useRef, useState } from 'react';

const HOTSPOTS = [
  {
    id: 'branch',
    start: 0.25,
    end: 3.15,
    x: 24,
    y: 35,
    zoom: 1.65,
    label: 'Browser takes the turn',
    eyebrow: '01 · WATCH THE ROUTE',
    body: 'Pause on a browser action, focus the frame, and see exactly where Goldenboy is headed next.',
  },
  {
    id: 'trace',
    start: 2.5,
    end: 6.2,
    x: 56,
    y: 31,
    zoom: 1.9,
    label: 'Model shows its work',
    eyebrow: '02 · CHECK THE MIRROR',
    body: 'Open the context, evidence, and controls behind the decision instead of trusting a polished replay.',
  },
  {
    id: 'handoff',
    start: 5.65,
    end: 9.3,
    x: 79,
    y: 56,
    zoom: 1.72,
    label: 'You approve the handoff',
    eyebrow: '03 · YOUR CALL',
    body: 'Replay the step, inspect the outcome, or send the work forward. The final turn is always yours.',
  },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatTime(value) {
  if (!Number.isFinite(value)) return '0:00';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export default function InteractiveVideo() {
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const fileInputRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(9.375);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [activeId, setActiveId] = useState(null);
  const [hotspotsVisible, setHotspotsVisible] = useState(true);
  const [localVideo, setLocalVideo] = useState(null);
  const [uploadError, setUploadError] = useState('');

  const activeHotspot = useMemo(
    () => HOTSPOTS.find((hotspot) => hotspot.id === activeId) || null,
    [activeId],
  );

  const visibleHotspots = HOTSPOTS.filter(
    (hotspot) => hotspotsVisible && time >= hotspot.start && time <= hotspot.end,
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const syncTime = () => setTime(video.currentTime);
    const syncDuration = () => setDuration(video.duration || 9.375);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('loadedmetadata', syncDuration);
    video.addEventListener('durationchange', syncDuration);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    syncDuration();
    return () => {
      video.removeEventListener('timeupdate', syncTime);
      video.removeEventListener('loadedmetadata', syncDuration);
      video.removeEventListener('durationchange', syncDuration);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, []);

  useEffect(() => () => {
    if (localVideo?.url) URL.revokeObjectURL(localVideo.url);
  }, [localVideo]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  const seek = (value) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clamp(Number(value), 0, duration || 0);
    setTime(video.currentTime);
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setActiveId(null);
  };

  useEffect(() => {
    if (!activeId && zoom === 1) return undefined;
    const onEscape = (event) => {
      if (event.key === 'Escape') resetView();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [activeId, zoom]);

  const setZoomLevel = (nextZoom) => {
    const value = clamp(nextZoom, 1, 2.5);
    setZoom(value);
    if (value === 1) setPan({ x: 0, y: 0 });
  };

  const activateHotspot = (hotspot) => {
    videoRef.current?.pause();
    setActiveId(hotspot.id);
    setZoom(hotspot.zoom);
    setPan({ x: 0, y: 0 });
  };

  const startDrag = (event) => {
    if (zoom <= 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, pan };
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const bounds = stageRef.current.getBoundingClientRect();
    const maxX = bounds.width * (zoom - 1) * 0.42;
    const maxY = bounds.height * (zoom - 1) * 0.42;
    setPan({
      x: clamp(drag.pan.x + event.clientX - drag.x, -maxX, maxX),
      y: clamp(drag.pan.y + event.clientY - drag.y, -maxY, maxY),
    });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const openFullscreen = () => {
    stageRef.current?.requestFullscreen?.();
  };

  const prepareVideoSwap = () => {
    videoRef.current?.pause();
    setPlaying(false);
    setTime(0);
    setDuration(0);
    resetView();
  };

  const chooseLocalVideo = (event) => {
    const [file] = event.target.files || [];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setUploadError('Choose a video file to preview.');
      return;
    }

    prepareVideoSwap();
    setUploadError('');
    setLocalVideo({ name: file.name, url: URL.createObjectURL(file) });
  };

  const restoreDemoVideo = () => {
    prepareVideoSwap();
    setUploadError('');
    setLocalVideo(null);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      resetView();
      return;
    }
    if (event.target.tagName === 'INPUT') return;
    if (event.key === ' ' && !['INPUT', 'BUTTON'].includes(event.target.tagName)) {
      event.preventDefault();
      togglePlayback();
    }
    if (event.key === 'ArrowRight') seek(time + 1);
    if (event.key === 'ArrowLeft') seek(time - 1);
    if (event.key === '+' || event.key === '=') setZoomLevel(zoom + 0.25);
    if (event.key === '-') setZoomLevel(zoom - 0.25);
    if (event.key === '0') resetView();
  };

  return (
    <div className="interactive-player" onKeyDown={onKeyDown} tabIndex="0" aria-label="Interactive video demonstration">
      <div className="interactive-player-topline">
        <div><i /> INTERACTIVE RECORDING</div>
        <div className="interactive-player-status">
          <span className={localVideo ? 'local-file-name' : ''} title={localVideo?.name}>
            {localVideo?.name || (activeHotspot ? activeHotspot.eyebrow : 'CLICK A MILE MARKER TO INSPECT')}
          </span>
          {localVideo && (
            <button className="restore-video-button" onClick={restoreDemoVideo} aria-label="Restore bundled demo video">
              Restore demo
            </button>
          )}
          <button className="upload-video-button" onClick={() => fileInputRef.current?.click()}>
            <span aria-hidden="true">↑</span>{localVideo ? 'Replace video' : 'Upload video'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={chooseLocalVideo}
            hidden
          />
        </div>
      </div>

      <div className={`local-video-notice ${uploadError ? 'is-error' : ''}`} aria-live="polite">
        {uploadError || (localVideo ? 'Local preview active · Your file stays on this device' : '')}
      </div>

      <div
        ref={stageRef}
        className={`interactive-stage ${zoom > 1 ? 'is-zoomed' : ''}`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="interactive-media-pan" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0)` }}>
          <video
            ref={videoRef}
            className="interactive-media"
            muted={muted}
            playsInline
            preload="metadata"
            poster={localVideo ? undefined : '/media/neon-hero-poster.jpg'}
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: activeHotspot ? `${activeHotspot.x}% ${activeHotspot.y}%` : '50% 50%',
            }}
            onClick={togglePlayback}
            aria-label="Interactive guided demo recording"
            src={localVideo?.url}
          >
            {!localVideo && (
              <>
                <source src="/media/neon-hero-av1.mp4" type="video/mp4; codecs=av01.0.05M.08,opus" />
                <source src="/media/neon-hero.mp4" type="video/mp4" />
                <source src="/media/neon-hero.webm" type="video/webm" />
              </>
            )}
          </video>
        </div>

        <div className="interactive-scan" aria-hidden="true" />
        {visibleHotspots.map((hotspot) => (
          <button
            key={hotspot.id}
            className={`video-hotspot ${activeId === hotspot.id ? 'active' : ''}`}
            style={{ left: `${hotspot.x}%`, top: `${hotspot.y}%` }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              activateHotspot(hotspot);
            }}
            aria-label={`Inspect ${hotspot.label}`}
          >
            <i><b /></i><span>{hotspot.label}</span>
          </button>
        ))}

        {!playing && !activeHotspot && (
          <button className="video-play-overlay" onClick={togglePlayback} aria-label="Play interactive recording">
            <span>▶</span><b>Start the guided drive</b>
          </button>
        )}

        {activeHotspot && (
          <aside className="video-insight" aria-live="polite">
            <button aria-label="Close inspection" onClick={resetView}>×</button>
            <span>{activeHotspot.eyebrow}</span>
            <h3>{activeHotspot.label}</h3>
            <p>{activeHotspot.body}</p>
            <div><i /> Drag to look around · Esc resets</div>
          </aside>
        )}
      </div>

      <div className="interactive-controls">
        <button onClick={togglePlayback} aria-label={playing ? 'Pause recording' : 'Play recording'}>{playing ? 'Ⅱ' : '▶'}</button>
        <span className="video-time">{formatTime(time)} / {formatTime(duration)}</span>
        <div className="video-scrubber">
          <input
            type="range"
            min="0"
            max={duration || 9.375}
            step="0.01"
            value={time}
            onChange={(event) => seek(event.target.value)}
            aria-label="Recording timeline"
            style={{ '--progress': `${(time / (duration || 1)) * 100}%` }}
          />
          {HOTSPOTS.map((hotspot) => (
            <button
              key={hotspot.id}
              className="timeline-marker"
              style={{ left: `${(hotspot.start / (duration || 9.375)) * 100}%` }}
              onClick={() => {
                seek(hotspot.start + 0.05);
                activateHotspot(hotspot);
              }}
              aria-label={`Jump to ${hotspot.label}`}
            />
          ))}
        </div>
        <div className="zoom-controls" aria-label="Video zoom controls">
          <button onClick={() => setZoomLevel(zoom - 0.25)} aria-label="Zoom out" disabled={zoom <= 1}>−</button>
          <button className="zoom-value" onClick={resetView} aria-label="Reset video zoom">{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoomLevel(zoom + 0.25)} aria-label="Zoom in" disabled={zoom >= 2.5}>+</button>
        </div>
        <button onClick={() => setHotspotsVisible(!hotspotsVisible)} aria-pressed={hotspotsVisible} aria-label="Toggle interactive hotspots">◎</button>
        <button onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute recording' : 'Mute recording'}>{muted ? '⌁' : '◖'}</button>
        <button onClick={openFullscreen} aria-label="Open recording fullscreen">↗</button>
      </div>

      <div className="interactive-legend">
        {HOTSPOTS.map((hotspot, index) => (
          <button
            key={hotspot.id}
            onClick={() => {
              seek(hotspot.start + 0.05);
              activateHotspot(hotspot);
            }}
          >
            <span>0{index + 1}</span><b>{hotspot.label}</b><small>{formatTime(hotspot.start)}</small>
          </button>
        ))}
        <p>Space play · ← → seek · + − zoom · 0 reset</p>
      </div>
    </div>
  );
}
