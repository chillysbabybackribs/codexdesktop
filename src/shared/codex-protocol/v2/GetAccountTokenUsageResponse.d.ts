import type { AccountTokenUsageDailyBucket } from "./AccountTokenUsageDailyBucket";
import type { AccountTokenUsageSummary } from "./AccountTokenUsageSummary";
export type GetAccountTokenUsageResponse = {
    summary: AccountTokenUsageSummary;
    dailyUsageBuckets: Array<AccountTokenUsageDailyBucket> | null;
};
