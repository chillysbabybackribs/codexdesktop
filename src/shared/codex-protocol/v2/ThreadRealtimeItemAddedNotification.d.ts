import type { JsonValue } from "../serde_json/JsonValue";
/**
 * EXPERIMENTAL - raw non-audio thread realtime item emitted by the backend.
 */
export type ThreadRealtimeItemAddedNotification = {
    threadId: string;
    item: JsonValue;
};
