import type { Model } from "./Model";
export type ModelListResponse = {
    data: Array<Model>;
    /**
     * Opaque cursor to pass to the next call to continue after the last item.
     * If None, there are no more items to return.
     */
    nextCursor: string | null;
};
