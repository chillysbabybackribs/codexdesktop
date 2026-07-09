/**
 * Response for `thread/decrement_elicitation`.
 */
export type ThreadDecrementElicitationResponse = {
    /**
     * Current out-of-band elicitation count after the decrement.
     */
    count: bigint;
    /**
     * Whether timeout accounting remains paused after applying the decrement.
     */
    paused: boolean;
};
