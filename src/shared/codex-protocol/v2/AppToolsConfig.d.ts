import type { AppToolApproval } from "./AppToolApproval";
export type AppToolsConfig = {
    [key in string]?: {
        enabled: boolean | null;
        approval_mode: AppToolApproval | null;
    };
};
