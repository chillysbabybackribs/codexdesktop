import type { ThreadTokenUsage } from "./ThreadTokenUsage";
export type ThreadTokenUsageUpdatedNotification = {
    threadId: string;
    turnId: string;
    tokenUsage: ThreadTokenUsage;
};
