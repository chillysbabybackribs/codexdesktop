import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type MarketplaceAddResponse = {
    marketplaceName: string;
    installedRoot: AbsolutePathBuf;
    alreadyAdded: boolean;
};
