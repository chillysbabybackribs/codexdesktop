import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type PluginInstallParams = {
    marketplacePath?: AbsolutePathBuf | null;
    remoteMarketplaceName?: string | null;
    pluginName: string;
};
