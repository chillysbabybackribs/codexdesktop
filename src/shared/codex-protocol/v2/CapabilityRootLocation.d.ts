/**
 * Location used to resolve a selected capability root.
 */
export type CapabilityRootLocation = {
    "type": "environment";
    environmentId: string;
    /**
     * Absolute path for the root in the selected environment.
     */
    path: string;
};
