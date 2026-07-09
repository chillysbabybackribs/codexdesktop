import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type SkillsConfigWriteParams = {
    /**
     * Path-based selector.
     */
    path?: AbsolutePathBuf | null;
    /**
     * Name-based selector.
     */
    name?: string | null;
    enabled: boolean;
};
