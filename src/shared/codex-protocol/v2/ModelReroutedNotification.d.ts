import type { ModelRerouteReason } from "./ModelRerouteReason";
export type ModelReroutedNotification = {
    threadId: string;
    turnId: string;
    fromModel: string;
    toModel: string;
    reason: ModelRerouteReason;
};
