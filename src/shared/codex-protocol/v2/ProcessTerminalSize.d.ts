/**
 * PTY size in character cells for `process/spawn` PTY sessions.
 */
export type ProcessTerminalSize = {
    /**
     * Terminal height in character cells.
     */
    rows: number;
    /**
     * Terminal width in character cells.
     */
    cols: number;
};
