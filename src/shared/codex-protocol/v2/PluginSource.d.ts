import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type PluginSource = {
    "type": "local";
    path: AbsolutePathBuf;
} | {
    "type": "git";
    url: string;
    path: string | null;
    refName: string | null;
    sha: string | null;
} | {
    "type": "npm";
    package: string;
    /**
     * Optional npm version or version range.
     */
    version: string | null;
    /**
     * Optional HTTPS registry URL. Authentication stays in the user's npm config.
     */
    registry: string | null;
} | {
    "type": "remote";
};
