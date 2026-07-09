import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { OverriddenMetadata } from "./OverriddenMetadata";
import type { WriteStatus } from "./WriteStatus";
export type ConfigWriteResponse = {
    status: WriteStatus;
    version: string;
    /**
     * Canonical path to the config file that was written.
     */
    filePath: AbsolutePathBuf;
    overriddenMetadata: OverriddenMetadata | null;
};
