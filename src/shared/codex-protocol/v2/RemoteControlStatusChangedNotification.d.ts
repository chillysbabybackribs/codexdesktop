import type { RemoteControlConnectionStatus } from "./RemoteControlConnectionStatus";
/**
 * Current remote-control connection status and remote identity exposed to clients.
 */
export type RemoteControlStatusChangedNotification = {
    status: RemoteControlConnectionStatus;
    serverName: string;
    installationId: string;
    environmentId: string | null;
};
