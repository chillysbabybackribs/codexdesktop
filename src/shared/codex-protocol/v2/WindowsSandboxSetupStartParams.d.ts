import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { WindowsSandboxSetupMode } from "./WindowsSandboxSetupMode";
export type WindowsSandboxSetupStartParams = {
    mode: WindowsSandboxSetupMode;
    cwd?: AbsolutePathBuf | null;
};
