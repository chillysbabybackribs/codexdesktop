import type { AbsolutePathBuf } from "../AbsolutePathBuf";
/**
 * Request metadata for an absolute path.
 */
export type FsGetMetadataParams = {
    /**
     * Absolute path to inspect.
     */
    path: AbsolutePathBuf;
};
