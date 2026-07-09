export type PermissionProfileSummary = {
    /**
     * Available permission profile identifier.
     */
    id: string;
    /**
     * Optional user-facing description for display in clients.
     */
    description: string | null;
    /**
     * Whether the effective requirements allow selecting this profile.
     */
    allowed: boolean;
};
