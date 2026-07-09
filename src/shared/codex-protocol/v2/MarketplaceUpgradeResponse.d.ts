import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { MarketplaceUpgradeErrorInfo } from "./MarketplaceUpgradeErrorInfo";
export type MarketplaceUpgradeResponse = {
    selectedMarketplaces: Array<string>;
    upgradedRoots: Array<AbsolutePathBuf>;
    errors: Array<MarketplaceUpgradeErrorInfo>;
};
