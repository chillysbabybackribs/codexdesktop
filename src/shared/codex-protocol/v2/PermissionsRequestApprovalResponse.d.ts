import type { GrantedPermissionProfile } from "./GrantedPermissionProfile";
import type { PermissionGrantScope } from "./PermissionGrantScope";
export type PermissionsRequestApprovalResponse = {
    permissions: GrantedPermissionProfile;
    scope: PermissionGrantScope;
    /**
     * Review every subsequent command in this turn before normal sandboxed execution.
     */
    strictAutoReview?: boolean;
};
