import type { ReasoningEffort } from "../ReasoningEffort";
export type NewThreadModelDefaults = {
    model: string | null;
    modelReasoningEffort: ReasoningEffort | null;
    serviceTier: string | null;
};
