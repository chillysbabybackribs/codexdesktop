import type { InternalSessionSource } from "./InternalSessionSource";
import type { SubAgentSource } from "./SubAgentSource";
export type SessionSource = "cli" | "vscode" | "exec" | "mcp" | {
    "custom": string;
} | {
    "internal": InternalSessionSource;
} | {
    "subagent": SubAgentSource;
} | "unknown";
