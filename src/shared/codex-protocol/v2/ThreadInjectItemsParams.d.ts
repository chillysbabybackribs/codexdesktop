import type { JsonValue } from "../serde_json/JsonValue";
export type ThreadInjectItemsParams = {
    threadId: string;
    /**
     * Raw Responses API items to append to the thread's model-visible history.
     */
    items: Array<JsonValue>;
};
