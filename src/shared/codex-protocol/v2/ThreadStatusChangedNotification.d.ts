import type { ThreadStatus } from "./ThreadStatus";
export type ThreadStatusChangedNotification = {
    threadId: string;
    status: ThreadStatus;
};
