export type ConsumeAccountRateLimitResetCreditParams = {
    /**
     * Identifies one logical reset attempt. A UUID is recommended; reuse the same value when
     * retrying that attempt.
     */
    idempotencyKey: string;
    /**
     * Opaque reset-credit identifier to redeem. When omitted, the backend selects the next
     * available credit.
     */
    creditId?: string | null;
};
