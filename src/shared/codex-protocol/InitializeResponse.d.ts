import type { AbsolutePathBuf } from "./AbsolutePathBuf";
export type InitializeResponse = {
    userAgent: string;
    /**
     * Absolute path to the server's $CODEX_HOME directory.
     */
    codexHome: AbsolutePathBuf;
    /**
     * Platform family for the running app-server target, for example
     * `"unix"` or `"windows"`.
     */
    platformFamily: string;
    /**
     * Operating system for the running app-server target, for example
     * `"macos"`, `"linux"`, or `"windows"`.
     */
    platformOs: string;
};
