import type { JsonValue } from "../serde_json/JsonValue";
import type { ConfigLayerSource } from "./ConfigLayerSource";
export type ConfigLayer = {
    name: ConfigLayerSource;
    version: string;
    config: JsonValue;
    disabledReason: string | null;
};
