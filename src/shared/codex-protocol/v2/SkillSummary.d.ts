import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { SkillInterface } from "./SkillInterface";
export type SkillSummary = {
    name: string;
    description: string;
    shortDescription: string | null;
    interface: SkillInterface | null;
    path: AbsolutePathBuf | null;
    enabled: boolean;
};
