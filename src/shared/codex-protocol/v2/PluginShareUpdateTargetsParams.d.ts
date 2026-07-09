import type { PluginShareTarget } from "./PluginShareTarget";
import type { PluginShareUpdateDiscoverability } from "./PluginShareUpdateDiscoverability";
export type PluginShareUpdateTargetsParams = {
    remotePluginId: string;
    discoverability: PluginShareUpdateDiscoverability;
    shareTargets: Array<PluginShareTarget>;
};
