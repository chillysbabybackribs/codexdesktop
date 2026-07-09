import type { RemoteControlConnectionStatus } from "./RemoteControlConnectionStatus";
export type RemoteControlStatusReadResponse = {
    status: RemoteControlConnectionStatus;
    serverName: string;
    installationId: string;
    environmentId: string | null;
};
