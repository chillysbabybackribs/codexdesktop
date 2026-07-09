import type { AbsolutePathBuf } from "../AbsolutePathBuf";
/**
 * List direct child names for a directory.
 */
export type FsReadDirectoryParams = {
    /**
     * Absolute directory path to read.
     */
    path: AbsolutePathBuf;
};
