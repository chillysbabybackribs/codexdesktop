import type { AbsolutePathBuf } from "../AbsolutePathBuf";
/**
 * Create a directory on the host filesystem.
 */
export type FsCreateDirectoryParams = {
    /**
     * Absolute directory path to create.
     */
    path: AbsolutePathBuf;
    /**
     * Whether parent directories should also be created. Defaults to `true`.
     */
    recursive?: boolean | null;
};
