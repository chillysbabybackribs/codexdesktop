import type { PluginShareDiscoverability } from "./PluginShareDiscoverability";
import type { PluginSharePrincipal } from "./PluginSharePrincipal";
export type PluginShareUpdateTargetsResponse = {
    principals: Array<PluginSharePrincipal>;
    discoverability: PluginShareDiscoverability;
};
