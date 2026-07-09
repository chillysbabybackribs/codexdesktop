import type { RateLimitResetCreditsSummary } from "./RateLimitResetCreditsSummary";
import type { RateLimitSnapshot } from "./RateLimitSnapshot";
export type GetAccountRateLimitsResponse = {
    /**
     * Backward-compatible single-bucket view; mirrors the historical payload.
     */
    rateLimits: RateLimitSnapshot;
    /**
     * Multi-bucket view keyed by metered `limit_id` (for example, `codex`).
     */
    rateLimitsByLimitId: {
        [key in string]?: RateLimitSnapshot;
    } | null;
    rateLimitResetCredits: RateLimitResetCreditsSummary | null;
};
