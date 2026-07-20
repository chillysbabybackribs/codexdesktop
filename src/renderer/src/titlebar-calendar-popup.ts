declare global {
  interface Window {
    titlebarCalendarPopup: {
      close: () => void;
    };
  }
}

const monthNames = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(2024, month, 1)),
);
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabelFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const footerFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

let selectedDate = new Date();
let visibleMonth = startOfMonth(selectedDate);

const monthSelect = document.getElementById('month') as HTMLSelectElement;
const yearSelect = document.getElementById('year') as HTMLSelectElement;
const grid = document.getElementById('calendar-grid') as HTMLDivElement;
const selectedLabel = document.getElementById('selected-label') as HTMLSpanElement;
const previousButton = document.getElementById('previous-month') as HTMLButtonElement;
const nextButton = document.getElementById('next-month') as HTMLButtonElement;
const todayButton = document.getElementById('today') as HTMLButtonElement;

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

function shiftDateByMonth(date: Date, amount: number): Date {
  const target = addMonths(date, amount);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
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

function focusDate(date: Date): void {
  selectedDate = date;
  visibleMonth = startOfMonth(date);
  render();
  window.requestAnimationFrame(() => {
    grid.querySelector<HTMLButtonElement>(`[data-date="${dateKey(date)}"]`)?.focus();
  });
}

function handleDayKeyDown(event: KeyboardEvent, date: Date): void {
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
      target = shiftDateByMonth(date, -1);
      break;
    case 'PageDown':
      target = shiftDateByMonth(date, 1);
      break;
    default:
      return;
  }
  event.preventDefault();
  focusDate(target);
}

function renderCaption(): void {
  monthSelect.replaceChildren(
    ...monthNames.map((month, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = month;
      return option;
    }),
  );
  monthSelect.value = String(visibleMonth.getMonth());

  const year = visibleMonth.getFullYear();
  yearSelect.replaceChildren(
    ...Array.from({ length: 17 }, (_, index) => year - 8 + index).map((value) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      return option;
    }),
  );
  yearSelect.value = String(year);
}

function render(): void {
  renderCaption();
  const now = new Date();
  const days = calendarDays(visibleMonth);
  const selectedIsVisible = days.some((day) => isSameDay(day, selectedDate));

  grid.replaceChildren(
    ...days.map((date) => {
      const button = document.createElement('button');
      const isOutside = date.getMonth() !== visibleMonth.getMonth();
      const isToday = isSameDay(date, now);
      const isSelected = isSameDay(date, selectedDate);
      const isKeyboardAnchor =
        isSelected || (!selectedIsVisible && !isOutside && date.getDate() === 1);

      button.type = 'button';
      button.className = `day${isOutside ? ' is-outside' : ''}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`;
      button.textContent = String(date.getDate());
      button.dataset.date = dateKey(date);
      button.tabIndex = isKeyboardAnchor ? 0 : -1;
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', dayLabelFormatter.format(date));
      button.setAttribute('aria-selected', String(isSelected));
      if (isToday) button.setAttribute('aria-current', 'date');
      button.addEventListener('click', () => focusDate(date));
      button.addEventListener('keydown', (event) => handleDayKeyDown(event, date));
      return button;
    }),
  );

  selectedLabel.textContent = footerFormatter.format(selectedDate);
}

previousButton.addEventListener('click', () => {
  visibleMonth = addMonths(visibleMonth, -1);
  render();
});
nextButton.addEventListener('click', () => {
  visibleMonth = addMonths(visibleMonth, 1);
  render();
});
monthSelect.addEventListener('change', () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), Number(monthSelect.value), 1);
  render();
});
yearSelect.addEventListener('change', () => {
  visibleMonth = new Date(Number(yearSelect.value), visibleMonth.getMonth(), 1);
  render();
});
todayButton.addEventListener('click', () => focusDate(new Date()));
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  window.titlebarCalendarPopup.close();
});

render();
window.requestAnimationFrame(() => {
  grid.querySelector<HTMLButtonElement>(`[data-date="${dateKey(selectedDate)}"]`)?.focus();
});

export {};
