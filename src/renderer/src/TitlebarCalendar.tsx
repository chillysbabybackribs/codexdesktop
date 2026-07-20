import { useEffect, useMemo, useRef, useState } from 'react';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const accessibleDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'full',
  timeStyle: 'short',
});

const fullDateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const dayLabelFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const monthNames = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(2024, month, 1)),
);

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isSameDay(left: Date, right: Date): boolean {
  return dateKey(left) === dateKey(right);
}

function calendarDays(month: Date): Date[] {
  const first = startOfMonth(month);
  const gridStart = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function TitlebarCalendar(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const years = useMemo(
    () => Array.from({ length: 17 }, (_, index) => visibleMonth.getFullYear() - 8 + index),
    [visibleMonth],
  );

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

  useEffect(() => {
    if (!isOpen) return;

    void window.api.browser.setOverlayOpen(true);

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);

    const focusId = window.requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(`[data-calendar-date="${dateKey(selectedDate)}"]`)
        ?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusId);
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      void window.api.browser.setOverlayOpen(false);
    };
  }, [isOpen]);

  const focusDate = (date: Date): void => {
    setSelectedDate(date);
    setVisibleMonth(startOfMonth(date));
    window.requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(`[data-calendar-date="${dateKey(date)}"]`)
        ?.focus();
    });
  };

  const handleDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, date: Date): void => {
    let target: Date | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        target = addDays(date, -1);
        break;
      case 'ArrowRight':
        target = addDays(date, 1);
        break;
      case 'ArrowUp':
        target = addDays(date, -7);
        break;
      case 'ArrowDown':
        target = addDays(date, 7);
        break;
      case 'Home':
        target = addDays(date, -date.getDay());
        break;
      case 'End':
        target = addDays(date, 6 - date.getDay());
        break;
      case 'PageUp':
        target = new Date(date.getFullYear(), date.getMonth() - 1, date.getDate());
        break;
      case 'PageDown':
        target = new Date(date.getFullYear(), date.getMonth() + 1, date.getDate());
        break;
      default:
        return;
    }

    event.preventDefault();
    focusDate(target);
  };

  const chooseToday = (): void => {
    const today = new Date();
    focusDate(today);
  };

  return (
    <div className="titlebar-calendar-root">
      <button
        ref={triggerRef}
        type="button"
        className="titlebar-clock"
        aria-label={`${accessibleDateTimeFormatter.format(now)}. Open calendar`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <time dateTime={now.toISOString()}>
          <span className="titlebar-clock-time">{timeFormatter.format(now)}</span>
          <span className="titlebar-clock-date">{shortDateFormatter.format(now)}</span>
        </time>
        <svg className="titlebar-clock-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>

      {isOpen ? (
        <div
          ref={popoverRef}
          className="titlebar-calendar-popover"
          role="dialog"
          aria-label="Calendar"
        >
          <div className="titlebar-calendar-heading">
            <button
              type="button"
              className="titlebar-calendar-nav"
              aria-label="Previous month"
              onClick={() => setVisibleMonth((month) => addMonths(month, -1))}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m10 3-5 5 5 5" />
              </svg>
            </button>

            <div className="titlebar-calendar-caption">
              <select
                aria-label="Month"
                value={visibleMonth.getMonth()}
                onChange={(event) =>
                  setVisibleMonth(
                    new Date(visibleMonth.getFullYear(), Number(event.currentTarget.value), 1),
                  )
                }
              >
                {monthNames.map((month, index) => (
                  <option key={month} value={index}>
                    {month}
                  </option>
                ))}
              </select>
              <select
                aria-label="Year"
                value={visibleMonth.getFullYear()}
                onChange={(event) =>
                  setVisibleMonth(
                    new Date(Number(event.currentTarget.value), visibleMonth.getMonth(), 1),
                  )
                }
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className="titlebar-calendar-nav"
              aria-label="Next month"
              onClick={() => setVisibleMonth((month) => addMonths(month, 1))}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 3 5 5-5 5" />
              </svg>
            </button>
          </div>

          <div className="titlebar-calendar-weekdays" aria-hidden="true">
            {weekdayNames.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>

          <div className="titlebar-calendar-grid" role="grid" aria-label="Choose a date">
            {days.map((date) => {
              const isOutside = date.getMonth() !== visibleMonth.getMonth();
              const isToday = isSameDay(date, now);
              const isSelected = isSameDay(date, selectedDate);

              return (
                <button
                  key={dateKey(date)}
                  type="button"
                  role="gridcell"
                  className={`titlebar-calendar-day${isOutside ? ' is-outside' : ''}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`}
                  aria-label={dayLabelFormatter.format(date)}
                  aria-current={isToday ? 'date' : undefined}
                  aria-selected={isSelected}
                  data-calendar-date={dateKey(date)}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => focusDate(date)}
                  onKeyDown={(event) => handleDayKeyDown(event, date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="titlebar-calendar-footer">
            <span>{fullDateFormatter.format(selectedDate)}</span>
            <button type="button" onClick={chooseToday}>
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
