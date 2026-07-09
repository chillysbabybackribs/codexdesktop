export type ThreadLoadedListParams = {
    /**
     * Opaque pagination cursor returned by a previous call.
     */
    cursor?: string | null;
    /**
     * Optional page size; defaults to no limit.
     */
    limit?: number | null;
};
