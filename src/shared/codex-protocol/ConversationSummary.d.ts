import type { ConversationGitInfo } from "./ConversationGitInfo";
import type { SessionSource } from "./SessionSource";
import type { ThreadId } from "./ThreadId";
export type ConversationSummary = {
    conversationId: ThreadId;
    path: string;
    preview: string;
    timestamp: string | null;
    updatedAt: string | null;
    modelProvider: string;
    cwd: string;
    cliVersion: string;
    source: SessionSource;
    gitInfo: ConversationGitInfo | null;
};
