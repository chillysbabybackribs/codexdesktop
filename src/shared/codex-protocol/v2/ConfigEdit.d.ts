import type { JsonValue } from "../serde_json/JsonValue";
import type { MergeStrategy } from "./MergeStrategy";
export type ConfigEdit = {
    keyPath: string;
    value: JsonValue;
    mergeStrategy: MergeStrategy;
};
