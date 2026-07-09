import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { PluginShareDiscoverability } from "./PluginShareDiscoverability";
import type { PluginShareTarget } from "./PluginShareTarget";
export type PluginShareSaveParams = {
    pluginPath: AbsolutePathBuf;
    remotePluginId?: string | null;
    discoverability?: PluginShareDiscoverability | null;
    shareTargets?: Array<PluginShareTarget> | null;
};
