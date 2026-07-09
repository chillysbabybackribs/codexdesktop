import type { ProcessTerminalSize } from "./ProcessTerminalSize";
/**
 * Resize a running PTY-backed `process/spawn` session.
 */
export type ProcessResizePtyParams = {
    /**
     * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
     */
    processHandle: string;
    /**
     * New PTY size in character cells.
     */
    size: ProcessTerminalSize;
};
