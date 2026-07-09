import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType";
import type { MigrationDetails } from "./MigrationDetails";
export type ExternalAgentConfigMigrationItem = {
    itemType: ExternalAgentConfigMigrationItemType;
    description: string;
    /**
     * Null or empty means home-scoped migration; non-empty means repo-scoped migration.
     */
    cwd: string | null;
    details: MigrationDetails | null;
};
