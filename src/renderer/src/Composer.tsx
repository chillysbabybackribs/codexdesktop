import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChatAttachment } from '../../shared/ipc';
import type { PluginSummary, ProviderId } from '../../shared/session-protocol';
import { steerComposerPlaceholder } from './app-helpers';
import { SendArrowIcon } from './AgentDock';
import {
  AttachmentButton,
  AttachmentStrip,
  saveBrowserFiles,
} from './Attachments';
import { composerDrafts } from './composer-draft';
import { FileMentionMenu, MentionGlyph } from './FileMentionMenu';
import {
  buildMentionContext,
  rankMentionCandidates,
  type FileMention,
  type MentionCandidate,
} from './mention-model';
import { flattenPlugins } from './plugin-lifecycle';
import { PluginMentionMenu } from './PluginMentionMenu';

export { discardComposerDraft } from './composer-draft';

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
  providerId = 'codex',
  footerLeading,
  footerContext,
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
  providerId?: ProviderId;
  footerLeading?: React.ReactNode;
  footerContext?: React.ReactNode;
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
  const [pluginMenuState, setPluginMenuState] = useState<'closed' | 'loading' | 'ready' | 'error'>(
    'closed',
  );
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

  return (
    <>
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
            ? steerComposerPlaceholder(providerId)
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
      <div className="composer-primary-action">
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
        ) : null}
      </div>
      </form>
      <div className="composer-control-bar" aria-label="Composer controls">
        <div className="composer-leading-actions">
          <button
            type="button"
            className="composer-auto-mode"
            disabled
            title="Security restriction level — automatic (manual controls coming soon)"
          >
            Auto
          </button>
          <button
            type="button"
            className="composer-new-thread-button"
            aria-label="New chat"
            title="New chat"
            disabled={isLoading || isTurnActive || hasDraft}
            onClick={onNewThread}
          >
            <NewChatIcon />
          </button>
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
        {footerContext ? <div className="composer-control-context">{footerContext}</div> : null}
        {footerTrailing ? <div className="composer-trailing-actions">{footerTrailing}</div> : null}
      </div>
    </>
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
