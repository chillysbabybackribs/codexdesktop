import type { AbsolutePathBuf } from "../AbsolutePathBuf";
/**
 * Successful response for `fs/watch`.
 */
export type FsWatchResponse = {
    /**
     * Canonicalized path associated with the watch.
     */
    path: AbsolutePathBuf;
};
