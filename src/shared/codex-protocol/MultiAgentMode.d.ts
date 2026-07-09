/**
 * Controls the effective multi-agent delegation instructions for a turn. `custom` means the
 * configured mode hint defines the policy instead of a built-in policy.
 */
export type MultiAgentMode = {
    "custom": string;
} | "explicitRequestOnly" | "proactive";
