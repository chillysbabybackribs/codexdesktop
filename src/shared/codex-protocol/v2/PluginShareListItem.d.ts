import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { PluginSummary } from "./PluginSummary";
export type PluginShareListItem = {
    plugin: PluginSummary;
    localPluginPath: AbsolutePathBuf | null;
};
