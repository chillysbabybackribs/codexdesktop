import type { ConfiguredHookHandler } from "./ConfiguredHookHandler";
export type ConfiguredHookMatcherGroup = {
    matcher: string | null;
    hooks: Array<ConfiguredHookHandler>;
};
