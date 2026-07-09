/**
 * Write stdin bytes to a running `process/spawn` session, close stdin, or
 * both.
 */
export type ProcessWriteStdinParams = {
    /**
     * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
     */
    processHandle: string;
    /**
     * Optional base64-encoded stdin bytes to write.
     */
    deltaBase64?: string | null;
    /**
     * Close stdin after writing `deltaBase64`, if present.
     */
    closeStdin?: boolean;
};
