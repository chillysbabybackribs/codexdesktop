import { memo, useMemo, useState } from 'react';
import type { ItemMeta, WorkItem } from './TaskActivity';
import { isHiddenDuringLiveStep, LiveActivityFeed, WorkGroup } from './TaskActivity';
import { AttachmentStrip, attachmentsFromUserInput } from './Attachments';
import { MarkdownContent, StreamingMarkdownContent } from './MarkdownContent';
import { stripMentionContext } from './mention-model';
import { stripIntakeInjections } from './main-chat-intake';
import { parseAuditFeedback } from './audit-trigger';
import { parseAgentContinuation } from './agent-continuation';
import { stripLegacyBrowserRoutingNote } from './browser-routing-note';
import { formatTokens } from './TraceModal';
import { isWorkItem, type ActivityItem, type ChatItem } from './transcript-model';

// Work items that stay visible when a settled turn's steps are collapsed:
// edits are the product, the plan is the status board — everything else is
// process and folds away Cursor-style.
function isEssentialWorkItem(item: WorkItem): boolean {
  return item.type === 'fileChange' || item.type === 'turnPlan';
}

export function TaskActivity({
  items,
  itemMeta,
  live,
  workspace,
  streamingMessage = false,
  turnId,
}: {
  items: ActivityItem[];
  itemMeta: Record<string, ItemMeta>;
  live: boolean;
  workspace: string | null;
  streamingMessage?: boolean;
  turnId?: string | null;
}): React.JSX.Element {
  // null = default by liveness: live turns show everything, settled turns
  // collapse their step rows to a "N steps" toggle.
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const showSteps = live || (stepsOpen ?? false);
  const workItems = useMemo(() => items.filter(isWorkItem), [items]);
  const hiddenStepCount = live
    ? 0
    : items.filter((item) => isWorkItem(item) && !isEssentialWorkItem(item)).length;

  let newestWorkItemId: string | undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isWorkItem(items[i])) {
      newestWorkItemId = items[i].id;
      break;
    }
  }
  const newestActivityId = items[items.length - 1]?.id;
  const content: React.JSX.Element[] = [];
  let workRun: WorkItem[] = [];

  const flushWork = (): void => {
    let visible = showSteps ? workRun : workRun.filter(isEssentialWorkItem);
    if (live) {
      visible = visible.filter((item) => !isHiddenDuringLiveStep(item, live));
    }
    workRun = [];
    if (!visible.length) {
      return;
    }
    const first = visible[0];
    content.push(
      <WorkGroup
        key={`work-${first.id}`}
        items={visible}
        itemMeta={itemMeta}
        live={live}
        workspace={workspace}
        newestItemId={newestWorkItemId}
      />,
    );
  };

  for (const item of items) {
    if (isWorkItem(item)) {
      workRun.push(item);
      continue;
    }

    flushWork();
    const messageStreaming =
      live && item.id === newestActivityId && !itemMeta[item.id]?.completedAtMs;
    content.push(
      <div
        className={`task-activity-message ${messageStreaming ? 'is-streaming' : ''}`}
        key={item.id}
      >
        {messageStreaming ? (
          <StreamingMarkdownContent text={item.text || ' '} />
        ) : (
          <MarkdownContent text={item.text || ' '} />
        )}
      </div>,
    );
  }
  flushWork();

  return (
    <section
      className={`task-activity ${live ? 'is-live' : ''}`}
      data-message-id={turnId ?? undefined}
      aria-label="In-task activity"
      aria-live={live ? 'polite' : 'off'}
    >
      {hiddenStepCount > 0 ? (
        <button
          type="button"
          className="activity-steps-toggle"
          aria-expanded={showSteps}
          onClick={() => setStepsOpen(!showSteps)}
        >
          <StepsChevronIcon className={`activity-steps-chevron ${showSteps ? 'is-open' : ''}`} />
          {hiddenStepCount} {hiddenStepCount === 1 ? 'step' : 'steps'}
        </button>
      ) : null}
      {live ? (
        <LiveActivityFeed
          items={workItems}
          itemMeta={itemMeta}
          streamingMessage={streamingMessage}
        />
      ) : null}
      <div className="task-activity-content">{content}</div>
    </section>
  );
}

function StepsChevronIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8.5 6 6 6-6 6" />
    </svg>
  );
}

export function stripAutomaticSkillMarker(text: string): string {
  return text.replace(/^\$artifact-first-web-research[ \t]*\r?\n/, '');
}

export function stripInjectedMemory(text: string): string {
  return text.replace(
    /^<codexdesktop-prior-chat-memory>[\s\S]*?<\/codexdesktop-prior-chat-memory>\s*Current user request:\s*/,
    '',
  );
}

export function visibleUserMessageText(item: Extract<ChatItem, { type: 'userMessage' }>): string {
  const text = item.content
    .filter((content) => content.type === 'text')
    .map((content) =>
      stripIntakeInjections(
        stripMentionContext(stripAutomaticSkillMarker(stripInjectedMemory(content.text))),
      ),
    )
    .join('\n');
  return stripLegacyBrowserRoutingNote(text);
}

// Injected model-facing text in the main transcript renders as a quiet
// retractable card — header row with an icon + title, expandable to the full
// content. The model still receives the raw injected block; this is display
// only. Used for auditor feedback and automatic background-agent
// continuations.
function RetractableNoteCard({
  icon,
  title,
  previewText,
  body,
}: {
  icon: string;
  title: string;
  previewText: string;
  body: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const firstLine = previewText.split('\n')[0] ?? '';
  const preview = firstLine.length > 90 ? `${firstLine.slice(0, 90).trimEnd()}…` : firstLine;
  return (
    <div className={`audit-feedback-card ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="audit-feedback-row"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="audit-feedback-flag" aria-hidden="true">
          {icon}
        </span>
        <span className="audit-feedback-title">{title}</span>
        {!open && preview ? <span className="audit-feedback-preview">{preview}</span> : null}
        <span className="audit-feedback-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="audit-feedback-body">
          <MarkdownContent text={body} />
        </div>
      ) : null}
    </div>
  );
}

function AuditFeedbackCard({
  agentTitle,
  report,
}: {
  agentTitle: string;
  report: string;
}): React.JSX.Element {
  return (
    <RetractableNoteCard
      icon="⚑"
      title={`Audit feedback · ${agentTitle}`}
      previewText={report}
      body={report}
    />
  );
}

export const ChatItemView = memo(function ChatItemView({
  item,
  meta,
  streaming,
  turnId,
}: {
  item: ChatItem;
  meta?: ItemMeta;
  streaming: boolean;
  turnId?: string | null;
}): React.JSX.Element | null {
  if (item.type === 'system') {
    return (
      <article className={`message message-system message-system-${item.level}`}>
        {item.text}
      </article>
    );
  }

  if (item.type === 'userMessage') {
    const text = visibleUserMessageText(item);
    const attachments = attachmentsFromUserInput(item.content);
    // Auditor feedback renders as a compact retractable card, not the raw
    // block the doer model receives.
    const feedback = parseAuditFeedback(text);
    if (feedback) {
      return (
        <article
          className="message message-audit-feedback"
          data-turn-id={turnId ?? undefined}
          data-message-id={turnId ?? undefined}
          data-message-anchor-id={turnId ?? undefined}
        >
          <AuditFeedbackCard agentTitle={feedback.agentTitle} report={feedback.report} />
        </article>
      );
    }
    // Automatic background-agent continuations are model plumbing, not user
    // prose: show a compact retractable card instead of the raw injected block.
    const continuation = parseAgentContinuation(text);
    if (continuation) {
      return (
        <article
          className="message message-audit-feedback"
          data-turn-id={turnId ?? undefined}
          data-message-id={turnId ?? undefined}
          data-message-anchor-id={turnId ?? undefined}
        >
          <RetractableNoteCard
            icon="⟳"
            title="Background agents · results applied"
            previewText={continuation.headline}
            body={continuation.report}
          />
        </article>
      );
    }

    return (
      <article
        className="message message-user"
        data-turn-id={turnId ?? undefined}
        data-message-id={turnId ?? undefined}
        data-message-anchor-id={turnId ?? undefined}
      >
        {text ? <p>{text}</p> : null}
        <AttachmentStrip attachments={attachments} />
      </article>
    );
  }

  if (item.type === 'agentMessage') {
    // Messages stream into the transcript live, Cursor-style — commentary
    // (in-task narration) renders slightly muted; the final answer full-weight.
    return (
      <AssistantMessage
        text={item.text}
        streaming={streaming}
        commentary={item.phase === 'commentary'}
        turnId={turnId}
      />
    );
  }

  if (item.type === 'contextCompaction') {
    const inProgress = Boolean(meta?.startedAtMs) && !meta?.completedAtMs;
    const before = meta?.compaction?.beforeTokens ?? null;
    const after = meta?.compaction?.afterTokens ?? null;

    if (inProgress) {
      return (
        <article className="message message-compaction">
          <span className="shimmer-text">
            {before
              ? `Compacting context — summarizing ${formatTokens(before)} tokens…`
              : 'Compacting context…'}
          </span>
        </article>
      );
    }

    // Compactions restored from history carry no token metadata; only live
    // ones can show the real shrink.
    const shrank = before !== null && after !== null && after < before;
    return (
      <article className="message message-compaction" data-message-id={turnId ?? undefined}>
        {shrank
          ? `Context compacted — ${formatTokens(before)} → ${formatTokens(after)} tokens (${Math.round((1 - after / before) * 100)}% smaller)`
          : 'Context compacted'}
      </article>
    );
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return (
      <article className="message message-system message-system-info">
        {item.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode'}
      </article>
    );
  }

  // Anything else (hookPrompt and future item types) stays quiet but visible.
  return (
    <article className="message message-tool" data-message-id={turnId ?? undefined}>
      <strong>{item.type}</strong>
    </article>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming,
  commentary,
  turnId,
}: {
  text: string;
  streaming: boolean;
  commentary: boolean;
  turnId?: string | null;
}): React.JSX.Element {
  return (
    <article
      className={`message message-assistant ${commentary ? 'message-commentary' : ''} ${
        streaming ? 'is-streaming' : ''
      }`}
      data-message-id={turnId ?? undefined}
    >
      {streaming ? (
        <StreamingMarkdownContent text={text || ' '} />
      ) : (
        <MarkdownContent text={text || ' '} />
      )}
    </article>
  );
});
