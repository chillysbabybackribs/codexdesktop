import type { ThreadResumeInitialTurnsPageParams } from '../../shared/codex-protocol/v2/ThreadResumeInitialTurnsPageParams.js'

export type ResumeHistoryConsumer = 'main' | 'background' | 'agent'

const resumeHistoryPages: Record<ResumeHistoryConsumer, ThreadResumeInitialTurnsPageParams> = {
  // The focused transcript needs enough recent context to be useful, but not
  // the whole persisted rollout before the first frame can render.
  // A completed turn normally supplies the latest user/assistant pair, which
  // is enough to make a restored chat feel immediately present.
  main: { limit: 1, sortDirection: 'desc', itemsView: 'full' },
  // Background tabs only need to know whether their newest turn is running.
  background: { limit: 1, sortDirection: 'desc', itemsView: 'summary' },
  // The dock shows a compact tail, so loading more than a few full turns is
  // wasted startup work.
  agent: { limit: 6, sortDirection: 'desc', itemsView: 'full' }
}

export function resumeHistoryPageFor(consumer: ResumeHistoryConsumer): ThreadResumeInitialTurnsPageParams {
  return { ...resumeHistoryPages[consumer] }
}
