import type { ThreadId } from "./ThreadId";
export type GetConversationSummaryParams = {
    rolloutPath: string;
} | {
    conversationId: ThreadId;
};
