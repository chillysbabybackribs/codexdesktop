import type { PluginSharePrincipalRole } from "./PluginSharePrincipalRole";
import type { PluginSharePrincipalType } from "./PluginSharePrincipalType";
export type PluginSharePrincipal = {
    principalType: PluginSharePrincipalType;
    principalId: string;
    role: PluginSharePrincipalRole;
    name: string;
};
