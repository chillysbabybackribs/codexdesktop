import type { AppSummary } from "./AppSummary";
import type { PluginAuthPolicy } from "./PluginAuthPolicy";
export type PluginInstallResponse = {
    authPolicy: PluginAuthPolicy;
    appsNeedingAuth: Array<AppSummary>;
};
