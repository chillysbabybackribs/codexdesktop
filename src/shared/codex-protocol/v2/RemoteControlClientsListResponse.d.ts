import type { RemoteControlClient } from "./RemoteControlClient";
export type RemoteControlClientsListResponse = {
    data: Array<RemoteControlClient>;
    nextCursor: string | null;
};
