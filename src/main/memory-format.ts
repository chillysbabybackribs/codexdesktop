export type MemoryTurn = {
  user: string
  assistant: string
  completedWork?: string[]
}

export type MemorySnapshot = {
  threadId: string
  title: string
  workspace: string | null
  updatedAt: string
  turns: MemoryTurn[]
}

// Keep only two recent exchanges in the bounded checkpoint. Older details are
// discoverable through milestone search and the full transcript fallback.
const recentTurnCount = 2
const maxMilestones = 6
const maxTitleChars = 120
const maxLatestUserChars = 800
const maxLatestAssistantChars = 2_400

export function buildLastChatMarkdown(snapshot: MemorySnapshot, transcriptPath: string): string {
  const turns = snapshot.turns.filter((turn) => turn.user.trim() && turn.assistant.trim())
  const latest = turns.at(-1)

  if (!latest) return ''

  const recent = turns.slice(-recentTurnCount)
  const earlier = turns.slice(0, -recent.length)
  const milestones = earlier.slice(-maxMilestones)
  const omitted = earlier.length - milestones.length
  const milestoneStart = omitted + 1
  const recentStart = turns.length - recent.length + 1
  const workspace = cleanLine(snapshot.workspace ?? 'Not selected')

  const recentProgress = recent.slice(0, -1).map((turn, index) => {
    const turnNumber = String(recentStart + index).padStart(2, '0')
    return `- **T${turnNumber} — ${brief(turn.user, 90)}:** ${meaningfulBrief(turn.assistant, 180)}`
  })

  const milestoneLines = milestones.map((turn, index) => {
    const turnNumber = String(milestoneStart + index).padStart(2, '0')
    return `- **T${turnNumber} — ${brief(turn.user, 90)}:** ${meaningfulBrief(turn.assistant, 180)}`
  })

  if (omitted > 0) {
    milestoneLines.unshift(`- **Earlier history:** ${omitted} older turns remain available in the full transcript.`)
  }

  return `${[
    `# ${clipBlock(cleanLine(snapshot.title), maxTitleChars) || 'Previous chat'}`,
    '',
    `Updated: ${cleanLine(snapshot.updatedAt)}`,
    `Workspace: ${workspace}`,
    `Source thread: ${cleanLine(snapshot.threadId)}`,
    `Full transcript: ${cleanLine(transcriptPath)}`,
    '',
    '## Current state',
    '',
    ...(recentProgress.length ? ['Recent progression:', '', ...recentProgress, ''] : []),
    `Latest request: ${clipBlock(latest.user, maxLatestUserChars)}`,
    '',
    `Latest outcome:\n\n${clipHeadAndTail(latest.assistant, maxLatestAssistantChars)}`,
    ...(latest.completedWork?.length
      ? ['', 'Latest completed work:', '', ...latest.completedWork.slice(0, 2).map((item) => `- ${brief(item, 220)}`)]
      : []),
    '',
    '## Earlier milestones',
    '',
    ...(milestoneLines.length ? milestoneLines : ['- No earlier completed turns.']),
    '',
    'This is historical starting context. The current conversation supersedes it whenever they conflict.',
    ''
  ].join('\n')}`
}

export function buildTranscriptMarkdown(snapshot: MemorySnapshot): string {
  const sections = snapshot.turns
    .filter((turn) => turn.user.trim() || turn.assistant.trim())
    .map((turn, index) => {
      const chapterNumber = String(index + 1).padStart(2, '0')
      const marker = `codexdesktop-turn:${cleanLine(snapshot.threadId)}:C${chapterNumber}`
      return [
        `<!-- ${marker}:start -->`,
        `## Turn C${chapterNumber} — ${brief(turn.user, 100)}`,
        '',
        '### User',
        '',
        turn.user.trim(),
        '',
        '### Assistant',
        '',
        turn.assistant.trim(),
        ...(turn.completedWork?.length
          ? ['', '### Completed work', '', ...turn.completedWork.slice(0, 2).map((item) => `- ${item}`)]
          : []),
        '',
        `<!-- ${marker}:end -->`
      ].join('\n')
    })

  return `${[
    `# Full conversation: ${cleanLine(snapshot.title) || 'Previous chat'}`,
    '',
    `Updated: ${cleanLine(snapshot.updatedAt)}`,
    `Workspace: ${cleanLine(snapshot.workspace ?? 'Not selected')}`,
    `Source thread: ${cleanLine(snapshot.threadId)}`,
    '',
    ...sections,
    ''
  ].join('\n')}`
}

function brief(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  const sentence = line.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? line
  const clipped = sentence.slice(0, maxChars).trimEnd()
  return clipped.length < sentence.length ? `${clipped}…` : clipped || 'Untitled'
}

function meaningfulBrief(value: string, maxChars: number): string {
  const candidates = value
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .map((part) => part.replace(/^[#>*\-\d.\s]+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const meaningful = candidates.find((part) =>
    part.length >= 24 && !/^(yes|no|correct|exactly|agreed|done)[.!]?$/i.test(part)
  )

  return brief(meaningful ?? candidates[0] ?? value, maxChars)
}

function clipBlock(value: string, maxChars: number): string {
  const trimmed = value.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}…` : trimmed
}

function clipHeadAndTail(value: string, maxChars: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed

  const tailChars = Math.floor(maxChars / 3)
  const headChars = maxChars - tailChars
  return `${trimmed.slice(0, headChars).trimEnd()}\n\n[…]\n\n${trimmed.slice(-tailChars).trimStart()}`
}

function cleanLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}
