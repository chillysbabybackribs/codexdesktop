import type { FsReadDirectoryEntry } from "./FsReadDirectoryEntry";
/**
 * Directory entries returned by `fs/readDirectory`.
 */
export type FsReadDirectoryResponse = {
    /**
     * Direct child entries in the requested directory.
     */
    entries: Array<FsReadDirectoryEntry>;
};
