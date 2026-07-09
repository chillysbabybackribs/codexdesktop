import type { TurnPlanStep } from "./TurnPlanStep";
export type TurnPlanUpdatedNotification = {
    threadId: string;
    turnId: string;
    explanation: string | null;
    plan: Array<TurnPlanStep>;
};
