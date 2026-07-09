import type { AuthMode } from "../AuthMode";
import type { PlanType } from "../PlanType";
export type AccountUpdatedNotification = {
    authMode: AuthMode | null;
    planType: PlanType | null;
};
