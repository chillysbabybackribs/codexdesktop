import type { ExternalAgentConfigMigrationItem } from "./ExternalAgentConfigMigrationItem";
export type ExternalAgentConfigImportParams = {
    migrationItems: Array<ExternalAgentConfigMigrationItem>;
    /**
     * Source product that produced the migration items. Missing means unspecified.
     */
    source?: string | null;
};
