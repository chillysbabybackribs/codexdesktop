import type { FuzzyFileSearchResult } from "./FuzzyFileSearchResult";
export type FuzzyFileSearchSessionUpdatedNotification = {
    sessionId: string;
    query: string;
    files: Array<FuzzyFileSearchResult>;
};
