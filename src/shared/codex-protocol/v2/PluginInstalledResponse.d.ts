import type { MarketplaceLoadErrorInfo } from "./MarketplaceLoadErrorInfo";
import type { PluginMarketplaceEntry } from "./PluginMarketplaceEntry";
export type PluginInstalledResponse = {
    marketplaces: Array<PluginMarketplaceEntry>;
    marketplaceLoadErrors: Array<MarketplaceLoadErrorInfo>;
};
