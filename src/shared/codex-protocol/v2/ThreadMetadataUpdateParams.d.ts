import type { ThreadMetadataGitInfoUpdateParams } from "./ThreadMetadataGitInfoUpdateParams";
export type ThreadMetadataUpdateParams = {
    threadId: string;
    /**
     * Patch the stored Git metadata for this thread.
     * Omit a field to leave it unchanged, set it to `null` to clear it, or
     * provide a string to replace the stored value.
     */
    gitInfo?: ThreadMetadataGitInfoUpdateParams | null;
};
