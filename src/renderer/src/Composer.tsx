import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChatAttachment } from '../../shared/ipc';
import type { PluginSummary } from '../../shared/session-protocol';
import { SendArrowIcon } from './AgentDock';
import {
  AttachmentButton,
  AttachmentStrip,
  saveBrowserFiles,
} from './Attachments';
import {
  buildMentionContext,
  rankMentionCandidates,
  type FileMention,
  type MentionCandidate,
} from './mention-model';
import { flattenPlugins, pluginUninstallId } from './plugin-lifecycle';
import { PluginGlyph } from './PluginBrowser';

type ComposerDraft = {
  value: string;
  attachments: ChatAttachment[];
  mentions?: FileMention[];
};

const composerDrafts = new Map<string, ComposerDraft>();

export function discardComposerDraft(key: string): void {
  composerDrafts.delete(key);
}

export function Composer({
  draftKey,
  docked,
  workspace,
  installedPlugins,
  onInstalledPluginsChange,
  onBrowsePlugins,
  isLoading,
  isTurnActive,
  status,
  onSend,
  onSteer,
  onStop,
  onNewThread,
  onNewAgent,
  footerLeading,
  footerTrailing,
}: {
  draftKey: string;
  docked: boolean;
  workspace: string | null;
  installedPlugins: PluginSummary[];
  onInstalledPluginsChange: (plugins: PluginSummary[]) => void;
  onBrowsePlugins: () => void;
  isLoading: boolean;
  isTurnActive: boolean;
  status: string;
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onNewThread: () => void;
  onNewAgent: () => void;
  footerLeading?: React.ReactNode;
  footerTrailing?: React.ReactNode;
}): React.JSX.Element {
  const [value, setValue] = useState(() => composerDrafts.get(draftKey)?.value ?? '');
  const [attachments, setAttachments] = useState<ChatAttachment[]>(
    () => composerDrafts.get(draftKey)?.attachments ?? [],
  );
  const [mentions, setMentions] = useState<FileMention[]>(
    () => composerDrafts.get(draftKey)?.mentions ?? [],
  );
  const [mentionIndex, setMentionIndex] = useState<{ files: string[]; dirs: string[] } | null>(
    null,
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const [pluginMenuState, setPluginMenuState] = useState<'closed' | 'loading' | 'ready' | 'error'>(
    'closed',
  );
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [pluginSelectionIndex, setPluginSelectionIndex] = useState(0);
  const pluginMention = value.match(/(?:^|\s)@([^\s@]*)$/);
  const pluginQuery = pluginMention?.[1].toLowerCase() ?? null;
  const hasDraft = Boolean(value.trim() || attachments.length || mentions.length);
  const isQuietStatus = status === 'idle' || status === 'ready';
  const visibleStatus = attachmentError ?? (isTurnActive || isQuietStatus ? null : status);

  useEffect(() => {
    composerDrafts.set(draftKey, { value, attachments, mentions });
  }, [draftKey, value, attachments, mentions]);

  // Workspace file index for @-mentions: fetched when a mention token opens,
  // cached for the life of that menu (the main process caches the git listing
  // too, so re-opens stay cheap).
  useEffect(() => {
    if (pluginQuery === null || !workspace) {
      setMentionIndex(null);
      return;
    }
    if (mentionIndex) return;
    let cancelled = false;
    void window.api.mentions.index({ workspace }).then(
      (result) => {
        if (!cancelled) setMentionIndex(result);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginQuery === null, workspace]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(190, Math.max(54, textarea.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    if (pluginQuery === null || isLoading) {
      setPluginMenuState('closed');
      return;
    }

    let cancelled = false;
    setPluginMenuState('loading');
    void window.api.session.listInstalledPlugins({ cwd: workspace }).then(
      (result) => {
        if (cancelled) return;
        onInstalledPluginsChange(
          flattenPlugins(result.marketplaces).filter((plugin) => plugin.installed),
        );
        setPluginMenuState('ready');
      },
      () => {
        if (!cancelled) setPluginMenuState('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pluginQuery !== null, workspace, isLoading, onInstalledPluginsChange]);

  useEffect(() => setPluginSelectionIndex(0), [pluginQuery]);

  useEffect(() => {
    if (hasDraft || isTurnActive || isLoading) {
      setIsCreateMenuOpen(false);
    }
  }, [hasDraft, isTurnActive, isLoading]);

  useEffect(() => {
    if (!isCreateMenuOpen) return;

    const handlePointerDown = (event: MouseEvent): void => {
      if (createMenuRef.current && !createMenuRef.current.contains(event.target as Node)) {
        setIsCreateMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsCreateMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCreateMenuOpen]);

  const mentionPlugins = installedPlugins.filter((plugin) => {
    const name = plugin.interface?.displayName || plugin.name;
    return (
      !pluginQuery ||
      name.toLowerCase().includes(pluginQuery) ||
      plugin.keywords.some((keyword) => keyword.toLowerCase().includes(pluginQuery))
    );
  });

  // File/folder candidates share the mention menu with plugins: files first,
  // one selection index spanning both sections.
  const fileCandidates = useMemo(
    () =>
      pluginQuery !== null && mentionIndex
        ? rankMentionCandidates(pluginQuery, mentionIndex.files, mentionIndex.dirs, 8)
        : [],
    [pluginQuery, mentionIndex],
  );
  const mentionOptionCount = fileCandidates.length + mentionPlugins.length;

  const chooseMention = (candidate: MentionCandidate): void => {
    const match = value.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return;
    const leadingSpace = match[0].startsWith(' ') ? ' ' : '';
    setMentions((current) =>
      current.some((mention) => mention.path === candidate.path && mention.kind === candidate.kind)
        ? current
        : [...current, { path: candidate.path, kind: candidate.kind }],
    );
    setValue(`${value.slice(0, match.index)}${leadingSpace}`);
    setPluginMenuState('closed');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const choosePlugin = (plugin: PluginSummary): void => {
    const match = value.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return;
    const leadingSpace = match[0].startsWith(' ') ? ' ' : '';
    const name = plugin.interface?.displayName || plugin.name;
    setValue(`${value.slice(0, match.index)}${leadingSpace}@${name} `);
    setPluginMenuState('closed');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseMentionOption = (index: number): void => {
    if (index < fileCandidates.length) {
      chooseMention(fileCandidates[index]);
    } else if (mentionPlugins.length) {
      choosePlugin(mentionPlugins[Math.min(index - fileCandidates.length, mentionPlugins.length - 1)]);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const text = value.trim();
    if ((!text && !attachments.length && !mentions.length) || isLoading) {
      return;
    }

    setValue('');
    const submittedAttachments = attachments;
    const submittedMentions = mentions;
    if (!isTurnActive) setAttachments([]);
    setMentions([]);

    // Cursor-style resolution: mentioned files/folders are read now and ride
    // along inside a marker block the transcript strips from display.
    let outgoing = text;
    if (submittedMentions.length && workspace) {
      const resolved = await Promise.all(
        submittedMentions.map(async (mention) => ({
          ...mention,
          ...(await window.api.mentions
            .read({ workspace, path: mention.path, kind: mention.kind })
            .catch(() => ({ content: null, truncated: false }))),
        })),
      );
      outgoing = `${text}${buildMentionContext(resolved)}`;
    }

    const accepted = isTurnActive
      ? await onSteer(outgoing)
      : await onSend(outgoing, submittedAttachments);
    if (!accepted) {
      setValue((current) => (current ? `${text}\n${current}` : text));
      if (!isTurnActive) setAttachments(submittedAttachments);
      setMentions(submittedMentions);
    } else {
      composerDrafts.delete(draftKey);
    }
  };

  const runCreateCommand = (command: () => void): void => {
    setIsCreateMenuOpen(false);
    command();
  };

  return (
    <form
      className="composer"
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!isTurnActive && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (isTurnActive) return;
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        setAttachmentError(null);
        void saveBrowserFiles(files)
          .then((items) => setAttachments((current) => [...current, ...items]))
          .catch((error: unknown) =>
            setAttachmentError(error instanceof Error ? error.message : String(error)),
          );
      }}
    >
      {pluginMenuState !== 'closed' ? (
        <div className="composer-mention-stack">
          {fileCandidates.length ? (
            <FileMentionMenu
              candidates={fileCandidates}
              selectedIndex={pluginSelectionIndex}
              onChoose={chooseMention}
            />
          ) : null}
          <PluginMentionMenu
            state={pluginMenuState}
            plugins={mentionPlugins}
            selectedIndex={pluginSelectionIndex - fileCandidates.length}
            onChoose={choosePlugin}
            onBrowse={() => {
              setPluginMenuState('closed');
              onBrowsePlugins();
            }}
            onUninstalled={(pluginId) =>
              onInstalledPluginsChange(installedPlugins.filter((plugin) => plugin.id !== pluginId))
            }
          />
        </div>
      ) : null}
      {mentions.length ? (
        <div className="mention-strip" aria-label="Attached context">
          {mentions.map((mention) => (
            <span
              key={`${mention.kind}:${mention.path}`}
              className="mention-pill"
              title={mention.path}
            >
              <MentionGlyph kind={mention.kind} />
              <span className="mention-pill-name">
                {mention.path.split('/').pop() || mention.path}
              </span>
              <button
                type="button"
                className="mention-pill-remove"
                aria-label={`Remove ${mention.path}`}
                onClick={() =>
                  setMentions((current) =>
                    current.filter(
                      (existing) =>
                        !(existing.path === mention.path && existing.kind === mention.kind),
                    ),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <AttachmentStrip
        attachments={attachments}
        removable
        onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
      />
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={
          isTurnActive
            ? 'Add guidance while Codex works…'
            : docked
              ? 'Reply…'
              : 'Plan, build, or ask anything…'
        }
        disabled={isLoading}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => {
          if (isTurnActive) return;
          const images = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
          );
          if (!images.length) return;
          const pastedText = event.clipboardData.getData('text/plain');
          const start = event.currentTarget.selectionStart;
          const end = event.currentTarget.selectionEnd;
          event.preventDefault();
          if (pastedText)
            setValue((current) => `${current.slice(0, start)}${pastedText}${current.slice(end)}`);
          setAttachmentError(null);
          void saveBrowserFiles(images)
            .then((items) => setAttachments((current) => [...current, ...items]))
            .catch((error: unknown) =>
              setAttachmentError(error instanceof Error ? error.message : String(error)),
            );
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && pluginMenuState !== 'closed') {
            event.preventDefault();
            setPluginMenuState('closed');
            return;
          }
          if (pluginMenuState === 'ready' && mentionOptionCount && event.key === 'ArrowDown') {
            event.preventDefault();
            setPluginSelectionIndex((current) => (current + 1) % mentionOptionCount);
            return;
          }
          if (pluginMenuState === 'ready' && mentionOptionCount && event.key === 'ArrowUp') {
            event.preventDefault();
            setPluginSelectionIndex(
              (current) => (current - 1 + mentionOptionCount) % mentionOptionCount,
            );
            return;
          }
          if (
            pluginMenuState === 'ready' &&
            mentionOptionCount &&
            event.key === 'Enter' &&
            !event.shiftKey
          ) {
            event.preventDefault();
            chooseMentionOption(Math.min(pluginSelectionIndex, mentionOptionCount - 1));
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <div className="composer-leading-actions">
          <AttachmentButton
            disabled={isLoading || isTurnActive}
            onAdd={(items) => {
              setAttachmentError(null);
              setAttachments((current) => [...current, ...items]);
            }}
            onError={setAttachmentError}
          />
          {footerLeading}
        </div>
        {visibleStatus ? (
          <span className={`composer-status ${isLoading ? 'is-active' : ''}`}>{visibleStatus}</span>
        ) : null}
        {footerTrailing ? <div className="composer-trailing-actions">{footerTrailing}</div> : null}
        <div className="composer-primary-action" ref={createMenuRef}>
          {isTurnActive ? (
            <button
              type="button"
              className="stop-square-button"
              aria-label="Stop turn"
              title="Stop"
              onClick={() => void onStop()}
            >
              <span className="stop-square" aria-hidden="true" />
            </button>
          ) : hasDraft ? (
            <button
              type="submit"
              className="send-button"
              aria-label="Send message"
              disabled={isLoading}
            >
              <SendArrowIcon />
            </button>
          ) : (
            <>
              {isCreateMenuOpen ? (
                <div className="composer-create-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-create-item"
                    onClick={() => runCreateCommand(onNewThread)}
                  >
                    <span className="composer-create-item-icon" aria-hidden="true">
                      <ChatBubbleIcon />
                    </span>
                    <span>New chat</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-create-item"
                    onClick={() => runCreateCommand(onNewAgent)}
                  >
                    <span className="composer-create-item-icon" aria-hidden="true">
                      <NewAgentIcon />
                    </span>
                    <span>New agent</span>
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className={`send-button composer-new-chat ${isCreateMenuOpen ? 'is-open' : ''}`}
                aria-label="Create"
                title="Create"
                aria-haspopup="menu"
                aria-expanded={isCreateMenuOpen}
                disabled={isLoading}
                onClick={() => setIsCreateMenuOpen((open) => !open)}
              >
                <NewChatIcon />
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}

function ChatBubbleIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8A1.5 1.5 0 0 1 18.5 15H9l-4 3.5V15H5.5A1.5 1.5 0 0 1 4 13.5v-8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NewChatIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function NewAgentIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3.75"
        y="6.75"
        width="12.5"
        height="10.5"
        rx="2.25"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M7.5 11.5h5M10 9v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M17.5 4.5v5M15 7h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The file/folder section of the @-mention menu (Cursor's @Files/@Folders).
// Shares one selection index with the plugin section below it.
function FileMentionMenu({
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

function MentionGlyph({ kind }: { kind: 'file' | 'folder' }): React.JSX.Element {
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

function PluginMentionMenu({
  state,
  plugins,
  selectedIndex,
  onChoose,
  onBrowse,
  onUninstalled,
}: {
  state: 'loading' | 'ready' | 'error';
  plugins: PluginSummary[];
  selectedIndex: number;
  onChoose: (plugin: PluginSummary) => void;
  onBrowse: () => void;
  onUninstalled: (pluginId: string) => void;
}): React.JSX.Element {
  const [removing, setRemoving] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const remove = (plugin: PluginSummary): void => {
    if (armed !== plugin.id) {
      setArmed(plugin.id);
      return;
    }
    const uninstallId = pluginUninstallId(plugin);
    if (!uninstallId) return;
    setRemoving(plugin.id);
    void window.api.session
      .uninstallPlugin(uninstallId)
      .then(() => {
        onUninstalled(plugin.id);
        setArmed(null);
      })
      .finally(() => setRemoving(null));
  };

  return (
    <div className="plugin-mention-menu" role="listbox" aria-label="Installed plugins">
      <div className="plugin-mention-heading">
        <span>Installed plugins</span>
        <span>{plugins.length || ''}</span>
      </div>
      <div className="plugin-mention-list">
        {state === 'loading' ? (
          <div className="plugin-menu-message shimmer-text">Loading plugins…</div>
        ) : null}
        {state === 'error' ? (
          <div className="plugin-menu-message">Plugins could not be loaded.</div>
        ) : null}
        {state === 'ready' && !plugins.length ? (
          <div className="plugin-menu-message">No matching installed plugins.</div>
        ) : null}
        {state === 'ready'
          ? plugins.map((plugin, index) => (
              <div
                className={`plugin-mention-row ${selectedIndex === index ? 'is-selected' : ''}`}
                key={plugin.id}
                role="option"
                aria-selected={selectedIndex === index}
              >
                <button
                  type="button"
                  className="plugin-mention-select"
                  onClick={() => onChoose(plugin)}
                >
                  <span className="plugin-glyph">
                    <PluginGlyph plugin={plugin} />
                  </span>
                  <span className="plugin-mention-copy">
                    <strong>{plugin.interface?.displayName || plugin.name}</strong>
                    <small>
                      {plugin.interface?.shortDescription ||
                        plugin.interface?.capabilities.slice(0, 2).join(' · ') ||
                        'Plugin'}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`plugin-remove ${armed === plugin.id ? 'is-armed' : ''}`}
                  aria-label={
                    armed === plugin.id ? `Confirm remove ${plugin.name}` : `Remove ${plugin.name}`
                  }
                  title={armed === plugin.id ? 'Click again to remove' : 'Remove plugin'}
                  disabled={removing === plugin.id}
                  onClick={() => remove(plugin)}
                >
                  {armed === plugin.id ? <span>Remove</span> : <TrashIcon />}
                </button>
              </div>
            ))
          : null}
      </div>
      <button type="button" className="browse-plugins-button" onClick={onBrowse}>
        <span>Browse plugins</span>
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}
