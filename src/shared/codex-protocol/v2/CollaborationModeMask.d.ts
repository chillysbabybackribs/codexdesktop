import type { ModeKind } from "../ModeKind";
import type { ReasoningEffort } from "../ReasoningEffort";
/**
 * EXPERIMENTAL - collaboration mode preset metadata for clients.
 */
export type CollaborationModeMask = {
    name: string;
    mode: ModeKind | null;
    model: string | null;
    reasoning_effort: ReasoningEffort | null | null;
};
