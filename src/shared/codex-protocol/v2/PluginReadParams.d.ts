import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type PluginReadParams = {
    marketplacePath?: AbsolutePathBuf | null;
    remoteMarketplaceName?: string | null;
    pluginName: string;
};
