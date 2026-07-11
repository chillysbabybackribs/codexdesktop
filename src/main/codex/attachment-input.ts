import type { UserInput } from '../../shared/codex-protocol/v2/UserInput.js'
import type { ChatAttachment } from '../../shared/ipc.js'

export function attachmentTurnInputs(attachments: ChatAttachment[]): UserInput[] {
  return attachments.map((attachment): UserInput => attachment.kind === 'image'
    // `auto` maps to original-resolution processing on current GPT-5.5/5.6
    // models. High retains screenshot fidelity while applying a finite
    // image-token budget instead of carrying full-size pixels by default.
    ? { type: 'localImage', path: attachment.path, detail: 'high' }
    : { type: 'mention', name: attachment.name, path: attachment.path })
}
