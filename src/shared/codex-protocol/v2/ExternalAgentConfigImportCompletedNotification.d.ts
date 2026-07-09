import type { ExternalAgentConfigImportTypeResult } from "./ExternalAgentConfigImportTypeResult";
export type ExternalAgentConfigImportCompletedNotification = {
    importId: string;
    itemTypeResults: Array<ExternalAgentConfigImportTypeResult>;
};
