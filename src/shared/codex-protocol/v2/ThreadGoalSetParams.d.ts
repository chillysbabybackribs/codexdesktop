import type { ThreadGoalStatus } from "./ThreadGoalStatus";
export type ThreadGoalSetParams = {
    threadId: string;
    objective?: string | null;
    status?: ThreadGoalStatus | null;
    tokenBudget?: number | null;
};
