import type { AmazonBedrockCredentialSource } from "../AmazonBedrockCredentialSource";
import type { PlanType } from "../PlanType";
export type Account = {
    "type": "apiKey";
} | {
    "type": "chatgpt";
    email: string | null;
    planType: PlanType;
} | {
    "type": "amazonBedrock";
    credentialSource: AmazonBedrockCredentialSource;
};
