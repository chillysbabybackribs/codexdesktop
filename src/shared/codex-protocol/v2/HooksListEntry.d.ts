import type { HookErrorInfo } from "./HookErrorInfo";
import type { HookMetadata } from "./HookMetadata";
export type HooksListEntry = {
    cwd: string;
    hooks: Array<HookMetadata>;
    warnings: Array<string>;
    errors: Array<HookErrorInfo>;
};
