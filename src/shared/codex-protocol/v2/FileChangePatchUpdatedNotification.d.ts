import type { FileUpdateChange } from "./FileUpdateChange";
export type FileChangePatchUpdatedNotification = {
    threadId: string;
    turnId: string;
    itemId: string;
    changes: Array<FileUpdateChange>;
};
