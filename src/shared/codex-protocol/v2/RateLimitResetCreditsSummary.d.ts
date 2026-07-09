import type { RateLimitResetCredit } from "./RateLimitResetCredit";
export type RateLimitResetCreditsSummary = {
    availableCount: bigint;
    /**
     * Detail rows for available reset credits, when the backend provides them.
     *
     * `null` means only `availableCount` is known, while an empty array means details were fetched
     * and no available credits were returned. The backend may cap this list, so its length can be
     * less than `availableCount`.
     */
    credits: Array<RateLimitResetCredit> | null;
};
