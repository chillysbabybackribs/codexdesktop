import type { ThreadBackgroundTerminal } from "./ThreadBackgroundTerminal";
export type ThreadBackgroundTerminalsListResponse = {
    data: Array<ThreadBackgroundTerminal>;
    /**
     * Opaque cursor to pass to the next call to continue after the last item.
     * If None, there are no more items to return.
     */
    nextCursor: string | null;
};
