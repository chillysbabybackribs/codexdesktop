import type { ExternalAgentConfigImportItemTypeFailure } from "./ExternalAgentConfigImportItemTypeFailure";
import type { ExternalAgentConfigImportItemTypeSuccess } from "./ExternalAgentConfigImportItemTypeSuccess";
export type ExternalAgentConfigImportHistory = {
    importId: string;
    completedAtMs: bigint;
    successes: Array<ExternalAgentConfigImportItemTypeSuccess>;
    failures: Array<ExternalAgentConfigImportItemTypeFailure>;
};
