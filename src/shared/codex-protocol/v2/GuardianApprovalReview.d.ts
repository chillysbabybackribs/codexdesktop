import type { GuardianApprovalReviewStatus } from "./GuardianApprovalReviewStatus";
import type { GuardianRiskLevel } from "./GuardianRiskLevel";
import type { GuardianUserAuthorization } from "./GuardianUserAuthorization";
/**
 * [UNSTABLE] Temporary approval auto-review payload used by
 * `item/autoApprovalReview/*` notifications. This shape is expected to change
 * soon.
 */
export type GuardianApprovalReview = {
    status: GuardianApprovalReviewStatus;
    riskLevel: GuardianRiskLevel | null;
    userAuthorization: GuardianUserAuthorization | null;
    rationale: string | null;
};
