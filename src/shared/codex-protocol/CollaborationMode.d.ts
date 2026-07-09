import type { ModeKind } from "./ModeKind";
import type { Settings } from "./Settings";
/**
 * Collaboration mode for a Codex session.
 */
export type CollaborationMode = {
    mode: ModeKind;
    settings: Settings;
};
