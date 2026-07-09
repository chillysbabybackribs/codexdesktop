import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type SkillInterface = {
    displayName?: string;
    shortDescription?: string;
    iconSmall?: AbsolutePathBuf;
    iconLarge?: AbsolutePathBuf;
    brandColor?: string;
    defaultPrompt?: string;
};
