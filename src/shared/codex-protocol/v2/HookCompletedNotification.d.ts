import type { HookRunSummary } from "./HookRunSummary";
export type HookCompletedNotification = {
    threadId: string;
    turnId: string | null;
    run: HookRunSummary;
};
