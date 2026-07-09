import type { SortDirection } from "./SortDirection";
export type ThreadItemsListParams = {
    threadId: string;
    /**
     * Optional turn id to filter by. When omitted, returns items across the thread.
     */
    turnId?: string | null;
    /**
     * Opaque cursor to pass to the next call to continue after the last item.
     */
    cursor?: string | null;
    /**
     * Optional item page size.
     */
    limit?: number | null;
    /**
     * Optional item pagination direction; defaults to ascending.
     */
    sortDirection?: SortDirection | null;
};
