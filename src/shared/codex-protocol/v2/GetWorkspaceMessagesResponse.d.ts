import type { WorkspaceMessage } from "./WorkspaceMessage";
export type GetWorkspaceMessagesResponse = {
    /**
     * Whether the workspace-message backend route is available for this client.
     */
    featureEnabled: boolean;
    /**
     * Active workspace messages returned by the backend.
     */
    messages: Array<WorkspaceMessage>;
};
