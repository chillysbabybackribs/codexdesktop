import type { SortDirection } from "./SortDirection";
import type { TurnItemsView } from "./TurnItemsView";
export type ThreadTurnsListParams = {
    threadId: string;
    /**
     * Opaque cursor to pass to the next call to continue after the last turn.
     */
    cursor?: string | null;
    /**
     * Optional turn page size.
     */
    limit?: number | null;
    /**
     * Optional turn pagination direction; defaults to descending.
     */
    sortDirection?: SortDirection | null;
    /**
     * How much item detail to include for each returned turn; defaults to summary.
     */
    itemsView?: TurnItemsView | null;
};
