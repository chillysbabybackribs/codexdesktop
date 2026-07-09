import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType";
export type ExternalAgentConfigImportItemTypeFailure = {
    itemType: ExternalAgentConfigMigrationItemType;
    errorType: string | null;
    failureStage: string;
    message: string;
    cwd: string | null;
    source: string | null;
};
