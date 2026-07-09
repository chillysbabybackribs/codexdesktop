import type { ExternalAgentConfigImportTypeResult } from "./ExternalAgentConfigImportTypeResult";
export type ExternalAgentConfigImportProgressNotification = {
    importId: string;
    itemTypeResults: Array<ExternalAgentConfigImportTypeResult>;
};
