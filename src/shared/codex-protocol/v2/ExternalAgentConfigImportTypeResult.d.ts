import type { ExternalAgentConfigImportItemTypeFailure } from "./ExternalAgentConfigImportItemTypeFailure";
import type { ExternalAgentConfigImportItemTypeSuccess } from "./ExternalAgentConfigImportItemTypeSuccess";
import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType";
export type ExternalAgentConfigImportTypeResult = {
    itemType: ExternalAgentConfigMigrationItemType;
    successes: Array<ExternalAgentConfigImportItemTypeSuccess>;
    failures: Array<ExternalAgentConfigImportItemTypeFailure>;
};
