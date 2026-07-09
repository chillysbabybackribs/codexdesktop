import type { HookRunSummary } from "./HookRunSummary";
export type HookStartedNotification = {
    threadId: string;
    turnId: string | null;
    run: HookRunSummary;
};
