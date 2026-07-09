import type { AbsolutePathBuf } from "../AbsolutePathBuf";
import type { AppSummary } from "./AppSummary";
import type { AppTemplateSummary } from "./AppTemplateSummary";
import type { PluginHookSummary } from "./PluginHookSummary";
import type { PluginSummary } from "./PluginSummary";
import type { SkillSummary } from "./SkillSummary";
export type PluginDetail = {
    marketplaceName: string;
    marketplacePath: AbsolutePathBuf | null;
    summary: PluginSummary;
    shareUrl: string | null;
    description: string | null;
    skills: Array<SkillSummary>;
    hooks: Array<PluginHookSummary>;
    apps: Array<AppSummary>;
    appTemplates: Array<AppTemplateSummary>;
    mcpServers: Array<string>;
};
