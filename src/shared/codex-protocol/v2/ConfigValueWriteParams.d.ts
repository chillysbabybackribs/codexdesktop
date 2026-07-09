import type { JsonValue } from "../serde_json/JsonValue";
import type { MergeStrategy } from "./MergeStrategy";
export type ConfigValueWriteParams = {
    keyPath: string;
    value: JsonValue;
    mergeStrategy: MergeStrategy;
    /**
     * Path to the config file to write; defaults to the user's `config.toml` when omitted.
     */
    filePath?: string | null;
    expectedVersion?: string | null;
};
