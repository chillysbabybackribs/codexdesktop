import type { SkillErrorInfo } from "./SkillErrorInfo";
import type { SkillMetadata } from "./SkillMetadata";
export type SkillsListEntry = {
    cwd: string;
    skills: Array<SkillMetadata>;
    errors: Array<SkillErrorInfo>;
};
