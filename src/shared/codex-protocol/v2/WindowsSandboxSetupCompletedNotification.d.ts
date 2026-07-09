import type { WindowsSandboxSetupMode } from "./WindowsSandboxSetupMode";
export type WindowsSandboxSetupCompletedNotification = {
    mode: WindowsSandboxSetupMode;
    success: boolean;
    error: string | null;
};
