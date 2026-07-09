import type { WorkspaceMessageType } from "./WorkspaceMessageType";
export type WorkspaceMessage = {
    messageId: string;
    messageType: WorkspaceMessageType;
    messageBody: string;
    /**
     * Unix timestamp (in seconds) when the message was created.
     */
    createdAt: number | null;
    /**
     * Unix timestamp (in seconds) when the message was archived.
     */
    archivedAt: number | null;
};
