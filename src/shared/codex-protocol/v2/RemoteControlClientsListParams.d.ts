import type { RemoteControlClientsListOrder } from "./RemoteControlClientsListOrder";
export type RemoteControlClientsListParams = {
    environmentId: string;
    cursor?: string | null;
    limit?: number | null;
    order?: RemoteControlClientsListOrder | null;
};
