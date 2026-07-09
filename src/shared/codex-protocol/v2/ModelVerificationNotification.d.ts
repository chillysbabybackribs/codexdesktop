import type { ModelVerification } from "./ModelVerification";
export type ModelVerificationNotification = {
    threadId: string;
    turnId: string;
    verifications: Array<ModelVerification>;
};
