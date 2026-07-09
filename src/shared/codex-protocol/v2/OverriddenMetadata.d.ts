import type { JsonValue } from "../serde_json/JsonValue";
import type { ConfigLayerMetadata } from "./ConfigLayerMetadata";
export type OverriddenMetadata = {
    message: string;
    overridingLayer: ConfigLayerMetadata;
    effectiveValue: JsonValue;
};
