import type { AbsolutePathBuf } from "../AbsolutePathBuf";
/**
 * Read a file from the host filesystem.
 */
export type FsReadFileParams = {
    /**
     * Absolute path to read.
     */
    path: AbsolutePathBuf;
};
