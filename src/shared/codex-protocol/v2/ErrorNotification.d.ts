import type { TurnError } from "./TurnError";
export type ErrorNotification = {
    error: TurnError;
    willRetry: boolean;
    threadId: string;
    turnId: string;
};
