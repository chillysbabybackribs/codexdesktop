import type { JsonValue } from "../serde_json/JsonValue";
export type ThreadApproveGuardianDeniedActionParams = {
    threadId: string;
    /**
     * Serialized `codex_protocol::protocol::GuardianAssessmentEvent`.
     */
    event: JsonValue;
};
