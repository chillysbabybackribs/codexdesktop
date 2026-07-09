import type { LocalShellExecAction } from "./LocalShellExecAction";
export type LocalShellAction = {
    "type": "exec";
} & LocalShellExecAction;
