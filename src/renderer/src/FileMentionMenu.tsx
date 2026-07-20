import type { MentionCandidate } from './mention-model';

// The file/folder section of the @-mention menu (Cursor's @Files/@Folders).
// Shares one selection index with the plugin section below it.
export function FileMentionMenu({
  candidates,
  selectedIndex,
  onChoose,
}: {
  candidates: MentionCandidate[];
  selectedIndex: number;
  onChoose: (candidate: MentionCandidate) => void;
}): React.JSX.Element {
  return (
    <div className="file-mention-menu" role="listbox" aria-label="Workspace files">
      <div className="file-mention-heading">Files &amp; folders</div>
      {candidates.map((candidate, index) => {
        const base = candidate.path.split('/').pop() || candidate.path;
        const dir = candidate.path.slice(0, Math.max(0, candidate.path.length - base.length - 1));
        return (
          <button
            key={`${candidate.kind}:${candidate.path}`}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            className={`file-mention-row ${selectedIndex === index ? 'is-selected' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(candidate)}
          >
            <MentionGlyph kind={candidate.kind} />
            <span className="file-mention-base">{base}</span>
            {dir ? <span className="file-mention-dir">{dir}</span> : null}
            {candidate.kind === 'folder' ? <span className="file-mention-kind">folder</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function MentionGlyph({ kind }: { kind: 'file' | 'folder' }): React.JSX.Element {
  return (
    <svg
      className="mention-glyph"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'folder' ? (
        <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h3.6a1.5 1.5 0 0 1 1.1.44l1 1.06h7.8A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5L3.5 7Z" />
      ) : (
        <>
          <path d="M13 4H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9.5L13 4Z" />
          <path d="M13 4v5.5h5.5" />
        </>
      )}
    </svg>
  );
}
