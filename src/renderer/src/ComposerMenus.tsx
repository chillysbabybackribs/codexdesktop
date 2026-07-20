import { useEffect, useMemo, useRef, useState } from 'react';

export type ComposerCommandOption = {
  id: string;
  command: string;
  title: string;
  detail: string;
  hint?: string;
  disabled?: boolean;
};

export function ComposerCommandMenu({
  options,
  selectedIndex,
  onChoose,
}: {
  options: ComposerCommandOption[];
  selectedIndex: number;
  onChoose: (option: ComposerCommandOption) => void;
}): React.JSX.Element {
  return (
    <div className="composer-popover composer-command-menu" role="listbox" aria-label="Commands">
      <div className="composer-popover-heading">
        <span>Commands</span>
        <kbd>↑↓ select · ↵ run</kbd>
      </div>
      <div className="composer-command-list">
        {options.length ? (
          options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`composer-command-row ${index === selectedIndex ? 'is-selected' : ''}`}
              disabled={option.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(option)}
            >
              <code>/{option.command}</code>
              <span className="composer-command-copy">
                <strong>{option.title}</strong>
                <small>{option.detail}</small>
              </span>
              {option.hint ? <kbd>{option.hint}</kbd> : null}
            </button>
          ))
        ) : (
          <div className="composer-popover-empty">No matching commands</div>
        )}
      </div>
    </div>
  );
}

export function ComposerHistoryMenu({
  entries,
  onSearch,
  onChoose,
  onClose,
}: {
  entries: string[];
  onSearch: (query: string) => void;
  onChoose: (entry: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => setSelectedIndex(0), [entries]);

  const selected = useMemo(
    () => entries[Math.min(selectedIndex, Math.max(0, entries.length - 1))],
    [entries, selectedIndex],
  );

  return (
    <div
      className="composer-popover composer-history-menu"
      role="dialog"
      aria-label="Prompt history"
    >
      <label className="composer-history-search">
        <SearchIcon />
        <input
          ref={inputRef}
          type="search"
          placeholder="Search prompt history"
          aria-label="Search prompt history"
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown' && entries.length) {
              event.preventDefault();
              setSelectedIndex((current) => (current + 1) % entries.length);
            } else if (event.key === 'ArrowUp' && entries.length) {
              event.preventDefault();
              setSelectedIndex((current) => (current - 1 + entries.length) % entries.length);
            } else if (event.key === 'Enter' && selected) {
              event.preventDefault();
              onChoose(selected);
            }
          }}
        />
        <kbd>Esc</kbd>
      </label>
      <div className="composer-history-list" role="listbox">
        {entries.length ? (
          entries.map((entry, index) => (
            <button
              key={`${index}:${entry}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={index === selectedIndex ? 'is-selected' : ''}
              onClick={() => onChoose(entry)}
            >
              {entry}
            </button>
          ))
        ) : (
          <div className="composer-popover-empty">No prompts found</div>
        )}
      </div>
    </div>
  );
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.75" cy="10.75" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="m15 15 4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
