import type { JsonValue } from "./serde_json/JsonValue";
/**
 * Contents returned when reading a resource from an MCP server.
 */
export type ResourceContent = {
    /**
     * The URI of this resource.
     */
    uri: string;
    mimeType?: string;
    text: string;
    _meta?: JsonValue;
} | {
    /**
     * The URI of this resource.
     */
    uri: string;
    mimeType?: string;
    blob: string;
    _meta?: JsonValue;
};
