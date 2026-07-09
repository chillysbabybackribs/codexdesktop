import type { PluginSharePrincipalType } from "./PluginSharePrincipalType";
import type { PluginShareTargetRole } from "./PluginShareTargetRole";
export type PluginShareTarget = {
    principalType: PluginSharePrincipalType;
    principalId: string;
    role: PluginShareTargetRole;
};
