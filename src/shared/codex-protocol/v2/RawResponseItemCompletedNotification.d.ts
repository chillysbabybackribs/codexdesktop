import type { ResponseItem } from "../ResponseItem";
export type RawResponseItemCompletedNotification = {
    threadId: string;
    turnId: string;
    item: ResponseItem;
};
