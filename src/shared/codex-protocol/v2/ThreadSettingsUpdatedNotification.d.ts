import type { ThreadSettings } from "./ThreadSettings";
export type ThreadSettingsUpdatedNotification = {
    threadId: string;
    threadSettings: ThreadSettings;
};
