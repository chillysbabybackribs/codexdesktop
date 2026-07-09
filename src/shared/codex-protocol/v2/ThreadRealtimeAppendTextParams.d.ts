import type { ConversationTextRole } from "../ConversationTextRole";
/**
 * EXPERIMENTAL - append text input to thread realtime.
 */
export type ThreadRealtimeAppendTextParams = {
    threadId: string;
    text: string;
    role: ConversationTextRole;
};
