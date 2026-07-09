import type { AppInfo } from "./AppInfo";
/**
 * EXPERIMENTAL - notification emitted when the app list changes.
 */
export type AppListUpdatedNotification = {
    data: Array<AppInfo>;
};
