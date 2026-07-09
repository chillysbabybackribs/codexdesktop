import type { JsonValue } from "./serde_json/JsonValue";
/**
 * A template description for resources available on the server.
 */
export type ResourceTemplate = {
    annotations?: JsonValue;
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
};
