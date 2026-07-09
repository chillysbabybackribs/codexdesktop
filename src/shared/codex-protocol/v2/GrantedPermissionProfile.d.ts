import type { AdditionalFileSystemPermissions } from "./AdditionalFileSystemPermissions";
import type { AdditionalNetworkPermissions } from "./AdditionalNetworkPermissions";
export type GrantedPermissionProfile = {
    network?: AdditionalNetworkPermissions;
    fileSystem?: AdditionalFileSystemPermissions;
};
