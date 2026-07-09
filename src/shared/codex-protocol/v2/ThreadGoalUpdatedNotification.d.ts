import type { ThreadGoal } from "./ThreadGoal";
export type ThreadGoalUpdatedNotification = {
    threadId: string;
    turnId: string | null;
    goal: ThreadGoal;
};
