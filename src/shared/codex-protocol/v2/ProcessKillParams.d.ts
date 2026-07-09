/**
 * Terminate a running `process/spawn` session.
 */
export type ProcessKillParams = {
    /**
     * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
     */
    processHandle: string;
};
