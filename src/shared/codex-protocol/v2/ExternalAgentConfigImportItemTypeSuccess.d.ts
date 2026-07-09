import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType";
export type ExternalAgentConfigImportItemTypeSuccess = {
    itemType: ExternalAgentConfigMigrationItemType;
    cwd: string | null;
    source: string | null;
    target: string | null;
};
