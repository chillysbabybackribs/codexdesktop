import type { Turn } from "./Turn";
export type TurnCompletedNotification = {
    threadId: string;
    turn: Turn;
};
