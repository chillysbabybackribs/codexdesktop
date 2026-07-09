import type { MarketplaceLoadErrorInfo } from "./MarketplaceLoadErrorInfo";
import type { PluginMarketplaceEntry } from "./PluginMarketplaceEntry";
export type PluginListResponse = {
    marketplaces: Array<PluginMarketplaceEntry>;
    marketplaceLoadErrors: Array<MarketplaceLoadErrorInfo>;
    featuredPluginIds: Array<string>;
};
