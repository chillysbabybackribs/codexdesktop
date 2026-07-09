import type { RemoteControlConnectionStatus } from "./RemoteControlConnectionStatus";
export type RemoteControlEnableResponse = {
    status: RemoteControlConnectionStatus;
    serverName: string;
    installationId: string;
    environmentId: string | null;
};
