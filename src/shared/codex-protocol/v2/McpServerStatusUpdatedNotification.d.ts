import type { McpServerStartupFailureReason } from "./McpServerStartupFailureReason";
import type { McpServerStartupState } from "./McpServerStartupState";
export type McpServerStatusUpdatedNotification = {
    threadId: string | null;
    name: string;
    status: McpServerStartupState;
    error: string | null;
    failureReason: McpServerStartupFailureReason | null;
};
