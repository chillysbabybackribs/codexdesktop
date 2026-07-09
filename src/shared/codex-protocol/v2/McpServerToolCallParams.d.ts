import type { JsonValue } from "../serde_json/JsonValue";
export type McpServerToolCallParams = {
    threadId: string;
    server: string;
    tool: string;
    arguments?: JsonValue;
    _meta?: JsonValue;
};
