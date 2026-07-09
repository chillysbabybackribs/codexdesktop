/**
 * PTY size in character cells for `command/exec` PTY sessions.
 */
export type CommandExecTerminalSize = {
    /**
     * Terminal height in character cells.
     */
    rows: number;
    /**
     * Terminal width in character cells.
     */
    cols: number;
};
