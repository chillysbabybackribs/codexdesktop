import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { MarketplaceInterface } from "./MarketplaceInterface";
import type { PluginSummary } from "./PluginSummary";
export type PluginMarketplaceEntry = {
    name: string;
    /**
     * Local marketplace file path when the marketplace is backed by a local file.
     * Remote-only catalog marketplaces do not have a local path.
     */
    path: AbsolutePathBuf | null;
    interface: MarketplaceInterface | null;
    plugins: Array<PluginSummary>;
};
