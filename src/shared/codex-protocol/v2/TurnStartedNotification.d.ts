import type { Turn } from "./Turn";
export type TurnStartedNotification = {
    threadId: string;
    turn: Turn;
};
