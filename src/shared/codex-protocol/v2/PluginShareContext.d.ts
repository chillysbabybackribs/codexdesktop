import type { PluginShareDiscoverability } from "./PluginShareDiscoverability";
import type { PluginSharePrincipal } from "./PluginSharePrincipal";
export type PluginShareContext = {
    remotePluginId: string;
    /**
     * Version of the remote shared plugin release when available.
     */
    remoteVersion: string | null;
    discoverability: PluginShareDiscoverability | null;
    shareUrl: string | null;
    creatorAccountUserId: string | null;
    creatorName: string | null;
    sharePrincipals: Array<PluginSharePrincipal> | null;
};
