import type { Turn } from "./Turn";
export type ThreadTurnsListResponse = {
    data: Array<Turn>;
    /**
     * Opaque cursor to pass to the next call to continue after the last turn.
     * if None, there are no more turns to return.
     */
    nextCursor: string | null;
    /**
     * Opaque cursor to pass as `cursor` when reversing `sortDirection`.
     * This is only populated when the page contains at least one turn.
     * Use it with the opposite `sortDirection` to include the anchor turn again
     * and catch updates to that turn.
     */
    backwardsCursor: string | null;
};
