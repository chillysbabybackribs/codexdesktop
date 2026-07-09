import type { JsonValue } from "../serde_json/JsonValue";
export type DynamicToolCallParams = {
    threadId: string;
    turnId: string;
    callId: string;
    namespace: string | null;
    tool: string;
    arguments: JsonValue;
};
