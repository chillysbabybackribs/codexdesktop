import type { RemoteControlConnectionStatus } from "./RemoteControlConnectionStatus";
export type RemoteControlDisableResponse = {
    status: RemoteControlConnectionStatus;
    serverName: string;
    installationId: string;
    environmentId: string | null;
};
