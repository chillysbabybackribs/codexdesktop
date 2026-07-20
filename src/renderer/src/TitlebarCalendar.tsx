import { useEffect, useRef, useState } from 'react';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function TitlebarCalendar(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let timeoutId: number;
    const refreshClock = (): void => {
      const next = new Date();
      setNow(next);
      timeoutId = window.setTimeout(
        refreshClock,
        60_000 - (next.getSeconds() * 1_000 + next.getMilliseconds()) + 20,
      );
    };
    const current = new Date();
    timeoutId = window.setTimeout(
      refreshClock,
      60_000 - (current.getSeconds() * 1_000 + current.getMilliseconds()) + 20,
    );
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => window.api.titlebarCalendar.onClosed(() => setIsOpen(false)), []);

  useEffect(
    () => () => {
      void window.api.titlebarCalendar.close();
    },
    [],
  );

  const toggleCalendar = (): void => {
    if (isOpen) {
      void window.api.titlebarCalendar.close();
      return;
    }

    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setIsOpen(true);
    void window.api.titlebarCalendar.open({
      x: rect.left + rect.width / 2,
      y: rect.bottom + 4,
    });
  };

  return (
    <button
      ref={triggerRef}
      type="button"
      className="titlebar-clock"
      aria-label={`${timeFormatter.format(now)}. Open calendar`}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={toggleCalendar}
    >
      <time dateTime={now.toISOString()}>
        <span className="titlebar-clock-time">{timeFormatter.format(now)}</span>
      </time>
    </button>
  );
}
