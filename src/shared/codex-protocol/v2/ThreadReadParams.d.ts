export type ThreadReadParams = {
    threadId: string;
    /**
     * When true, include turns and their items from rollout history.
     */
    includeTurns?: boolean;
};
