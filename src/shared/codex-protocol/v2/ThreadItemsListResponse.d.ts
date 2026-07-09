import type { ThreadItem } from "./ThreadItem";
export type ThreadItemsListResponse = {
    data: Array<ThreadItem>;
    /**
     * Opaque cursor to pass to the next call to continue after the last item.
     * if None, there are no more items to return.
     */
    nextCursor: string | null;
    /**
     * Opaque cursor to pass as `cursor` when reversing `sortDirection`.
     * This is only populated when the page contains at least one item.
     */
    backwardsCursor: string | null;
};
