import type { ReasoningEffort } from "./ReasoningEffort";
/**
 * Settings for a collaboration mode.
 */
export type Settings = {
    model: string;
    reasoning_effort: ReasoningEffort | null;
    developer_instructions: string | null;
};
