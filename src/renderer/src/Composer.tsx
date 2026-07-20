import {
  type FormEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import type { ChatAttachment } from '../../shared/ipc';
import type { PluginSummary, ProviderId } from '../../shared/session-protocol';
import { steerComposerPlaceholder } from './app-helpers';
import {
  AttachmentButton,
  AttachmentStrip,
  saveBrowserFiles,
} from './Attachments';
import { composerDrafts } from './composer-draft';
import {
  getQueuedComposerMessage,
  hasStashedComposerDraft,
  listComposerPrompts,
  recordComposerPrompt,
  setQueuedComposerMessage,
  stashComposerDraft,
  takeStashedComposerDraft,
  type ComposerActionMode,
  type QueuedComposerMessage,
} from './composer-interactions';
import {
  ComposerCommandMenu,
  ComposerHistoryMenu,
  type ComposerCommandOption,
} from './ComposerMenus';
import { FileMentionMenu, MentionGlyph } from './FileMentionMenu';
import {
  buildMentionContext,
  rankMentionCandidates,
  type FileMention,
  type MentionCandidate,
} from './mention-model';
import { flattenPlugins } from './plugin-lifecycle';
import { PluginMentionMenu } from './PluginMentionMenu';
import { IconButton } from './UiPrimitives';

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
  onNewAgent,
  providerId = 'codex',
  footerLeading,
  footerContext,
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
  onNewAgent?: () => void;
  providerId?: ProviderId;
  footerLeading?: React.ReactNode;
  footerContext?: React.ReactNode;
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
  const [queuedMessage, setQueuedMessageState] = useState<QueuedComposerMessage | null>(() =>
    getQueuedComposerMessage(draftKey),
  );
  const [turnAction, setTurnAction] = useState<ComposerActionMode>(
    providerId === 'claude' ? 'queue' : 'steer',
  );
  const [isTurnActionMenuOpen, setIsTurnActionMenuOpen] = useState(false);
  const [commandSelectionIndex, setCommandSelectionIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [hasStash, setHasStash] = useState(() => hasStashedComposerDraft(draftKey));
  const [isDispatchingQueued, setIsDispatchingQueued] = useState(false);
  const composerFormId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const createMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const turnActionMenuRef = useRef<HTMLDivElement | null>(null);
  const queuedDispatchRef = useRef(false);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [pluginMenuState, setPluginMenuState] = useState<'closed' | 'loading' | 'ready' | 'error'>(
    'closed',
  );
  const [pluginSelectionIndex, setPluginSelectionIndex] = useState(0);
  const pluginMention = value.match(/(?:^|\s)@([^\s@]*)$/);
  const pluginQuery = pluginMention?.[1].toLowerCase() ?? null;
  const slashCommand = value.match(/^\/([^\s]*)$/);
  const slashQuery = slashCommand?.[1].toLowerCase() ?? null;
  const hasDraft = Boolean(value.trim() || attachments.length || mentions.length);
  const isQuietStatus = status === 'idle' || status === 'ready';
  const visibleStatus = attachmentError ?? (isTurnActive || isQuietStatus ? null : status);
  const canSteer = providerId === 'codex';
  const effectiveTurnAction: ComposerActionMode =
    attachments.length && turnAction === 'steer' ? 'queue' : turnAction;

  const commandOptions = useMemo<ComposerCommandOption[]>(() => {
    const options: ComposerCommandOption[] = [
      {
        id: 'context',
        command: 'context',
        title: 'Add workspace context',
        detail: 'Find a file, folder, or installed plugin',
        hint: '@',
      },
      {
        id: 'attach',
        command: 'attach',
        title: 'Attach files',
        detail: 'Add images, documents, or source files',
      },
      {
        id: 'history',
        command: 'history',
        title: 'Search prompt history',
        detail: 'Reuse a previous instruction in this chat',
        hint: 'Ctrl R',
      },
      {
        id: 'new',
        command: 'new',
        title: 'New chat',
        detail: 'Start a fresh main conversation',
        disabled: isLoading || isTurnActive,
      },
      ...(onNewAgent
        ? [
            {
              id: 'agent',
              command: 'agent',
              title: 'New agent',
              detail: 'Open a focused parallel workspace',
            } satisfies ComposerCommandOption,
          ]
        : []),
      {
        id: 'plugins',
        command: 'plugins',
        title: 'Browse plugins',
        detail: 'Install tools, apps, and reusable workflows',
      },
      {
        id: 'clear',
        command: 'clear',
        title: 'Clear composer',
        detail: 'Remove text, attachments, and context',
      },
    ];
    if (slashQuery === null) return [];
    return options.filter((option) => {
      if (!slashQuery) return true;
      return `${option.command} ${option.title} ${option.detail}`.toLowerCase().includes(slashQuery);
    });
  }, [isLoading, isTurnActive, onNewAgent, slashQuery]);

  const historyEntries = useMemo(
    () => listComposerPrompts(draftKey, historyQuery),
    [draftKey, historyQuery, isHistoryOpen],
  );

  useEffect(() => {
    composerDrafts.set(draftKey, { value, attachments, mentions });
  }, [draftKey, value, attachments, mentions]);

  useEffect(() => {
    setQueuedComposerMessage(draftKey, queuedMessage);
  }, [draftKey, queuedMessage]);

  useEffect(() => {
    if (!isTurnActive) setIsTurnActionMenuOpen(false);
  }, [isTurnActive]);

  useEffect(() => {
    if (canSteer || turnAction !== 'steer') return;
    setTurnAction('queue');
  }, [canSteer, turnAction]);

  useEffect(() => setCommandSelectionIndex(0), [slashQuery]);

  useEffect(() => {
    if (!isTurnActionMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (
        turnActionMenuRef.current &&
        event.target instanceof Node &&
        !turnActionMenuRef.current.contains(event.target)
      ) {
        setIsTurnActionMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsTurnActionMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isTurnActionMenuOpen]);

  useEffect(() => {
    if (!queuedMessage || isTurnActive || isLoading || queuedDispatchRef.current) return;
    queuedDispatchRef.current = true;
    setIsDispatchingQueued(true);
    const resolveQueuedText = async (): Promise<string> => {
      if (!queuedMessage.mentions.length || !workspace) return queuedMessage.text;
      const resolved = await Promise.all(
        queuedMessage.mentions.map(async (mention) => ({
          ...mention,
          ...(await window.api.mentions
            .read({ workspace, path: mention.path, kind: mention.kind })
            .catch(() => ({ content: null, truncated: false }))),
        })),
      );
      return `${queuedMessage.text}${buildMentionContext(resolved)}`;
    };
    void resolveQueuedText()
      .then((text) => onSend(text, queuedMessage.attachments))
      .then((accepted) => {
        if (accepted) {
          setQueuedMessageState(null);
          return;
        }
        setValue(queuedMessage.displayText);
        setAttachments(queuedMessage.attachments);
        setMentions(queuedMessage.mentions);
        setQueuedMessageState(null);
      })
      .finally(() => {
        queuedDispatchRef.current = false;
        setIsDispatchingQueued(false);
      });
  }, [isLoading, isTurnActive, onSend, queuedMessage, workspace]);

  useEffect(() => {
    if (!isCreateMenuOpen) return;

    const animationFrame = window.requestAnimationFrame(() => {
      createMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (
        createMenuRef.current &&
        event.target instanceof Node &&
        !createMenuRef.current.contains(event.target)
      ) {
        setIsCreateMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsCreateMenuOpen(false);
      createMenuTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isCreateMenuOpen]);

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

  const clearDraft = (): void => {
    setValue('');
    setAttachments([]);
    setMentions([]);
    setAttachmentError(null);
    setPluginMenuState('closed');
    setCommandMenuDismissed(false);
  };

  const openHistory = (): void => {
    setHistoryQuery('');
    setIsHistoryOpen(true);
  };

  const toggleStash = (): void => {
    if (hasDraft) {
      stashComposerDraft(draftKey, { value, attachments, mentions });
      clearDraft();
      setHasStash(true);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const restored = takeStashedComposerDraft(draftKey);
    if (!restored) return;
    setValue(restored.value);
    setAttachments(restored.attachments);
    setMentions(restored.mentions);
    setHasStash(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseCommand = (option: ComposerCommandOption): void => {
    if (option.disabled) return;
    setCommandMenuDismissed(true);
    switch (option.id) {
      case 'context':
        setValue('@');
        break;
      case 'attach':
        setValue('');
        setAttachmentError(null);
        void window.api.attachments
          .pick()
          .then((items) => setAttachments((current) => [...current, ...items]))
          .catch((error: unknown) =>
            setAttachmentError(error instanceof Error ? error.message : String(error)),
          );
        break;
      case 'history':
        setValue('');
        openHistory();
        break;
      case 'new':
        clearDraft();
        onNewThread();
        break;
      case 'agent':
        clearDraft();
        onNewAgent?.();
        break;
      case 'plugins':
        setValue('');
        onBrowsePlugins();
        break;
      case 'clear':
        clearDraft();
        break;
    }
    if (option.id !== 'history') requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const resolveMentionText = async (text: string, selectedMentions: FileMention[]): Promise<string> => {
    if (!selectedMentions.length || !workspace) return text;
    const resolved = await Promise.all(
      selectedMentions.map(async (mention) => ({
        ...mention,
        ...(await window.api.mentions
          .read({ workspace, path: mention.path, kind: mention.kind })
          .catch(() => ({ content: null, truncated: false }))),
      })),
    );
    return `${text}${buildMentionContext(resolved)}`;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const text = value.trim();
    if ((!text && !attachments.length && !mentions.length) || isLoading) {
      return;
    }

    const submittedAttachments = attachments;
    const submittedMentions = mentions;
    clearDraft();

    if (isTurnActive && effectiveTurnAction !== 'steer') {
      if (queuedMessage) {
        setValue(text);
        setAttachments(submittedAttachments);
        setMentions(submittedMentions);
        setAttachmentError('A message is already queued for this chat.');
        return;
      }
      setQueuedMessageState({
        text,
        displayText: text,
        attachments: submittedAttachments,
        mentions: submittedMentions,
      });
      recordComposerPrompt(draftKey, text);
      composerDrafts.delete(draftKey);
      if (effectiveTurnAction === 'stop-send') await onStop();
      return;
    }

    // Cursor-style resolution: mentioned files/folders are read now and ride
    // along inside a marker block the transcript strips from display.
    const outgoing = await resolveMentionText(text, submittedMentions);
    const accepted = isTurnActive
      ? await onSteer(outgoing)
      : await onSend(outgoing, submittedAttachments);
    if (!accepted) {
      setValue((current) => (current ? `${text}\n${current}` : text));
      setAttachments(submittedAttachments);
      setMentions(submittedMentions);
    } else {
      recordComposerPrompt(draftKey, text);
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
          <IconButton
            type="button"
            className="stop-square-button"
            label="Stop turn"
            tooltip="Stop response"
            onClick={() => void onStop()}
          >
            <span className="stop-square" aria-hidden="true" />
          </IconButton>
        ) : hasDraft ? (
          <IconButton
            type="submit"
            className="send-button"
            label="Send message"
            tooltip="Send"
            shortcut="Enter"
            disabled={isLoading}
          >
            <ArrowUp strokeWidth={2} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      </form>
      <div className="composer-control-bar" aria-label="Composer controls">
        <div className="composer-leading-actions">
          <div className="composer-create-menu-wrap" ref={createMenuRef}>
            <IconButton
              ref={createMenuTriggerRef}
              type="button"
              className="composer-new-thread-button"
              label="Create"
              tooltip="Create chat or agent"
              side="top"
              aria-haspopup="menu"
              aria-expanded={isCreateMenuOpen}
              onClick={() => setIsCreateMenuOpen((open) => !open)}
            >
              <NewChatIcon />
            </IconButton>
            {isCreateMenuOpen ? (
              <div className="composer-create-menu" role="menu" aria-label="Create">
                <button
                  type="button"
                  className="composer-create-menu-item"
                  role="menuitem"
                  disabled={isLoading || isTurnActive || hasDraft}
                  onClick={() => {
                    setIsCreateMenuOpen(false);
                    onNewThread();
                  }}
                >
                  <NewChatIcon />
                  <span>New chat</span>
                </button>
                {onNewAgent ? (
                  <button
                    type="button"
                    className="composer-create-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setIsCreateMenuOpen(false);
                      onNewAgent();
                    }}
                  >
                    <NewAgentIcon />
                    <span>New agent</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
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
      </div>
    </>
  );
}

function NewChatIcon(): React.JSX.Element {
  return <Plus strokeWidth={1.8} aria-hidden="true" />;
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
