export type ThreadBackgroundTerminalsListParams = {
    threadId: string;
    /**
     * Opaque pagination cursor returned by a previous call.
     */
    cursor?: string | null;
    /**
     * Optional page size.
     */
    limit?: number | null;
};
