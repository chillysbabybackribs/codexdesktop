import type { CommandMigration } from "./CommandMigration";
import type { HookMigration } from "./HookMigration";
import type { McpServerMigration } from "./McpServerMigration";
import type { PluginsMigration } from "./PluginsMigration";
import type { SessionMigration } from "./SessionMigration";
import type { SkillMigration } from "./SkillMigration";
import type { SubagentMigration } from "./SubagentMigration";
export type MigrationDetails = {
    plugins: Array<PluginsMigration>;
    skills: Array<SkillMigration>;
    sessions: Array<SessionMigration>;
    mcpServers: Array<McpServerMigration>;
    hooks: Array<HookMigration>;
    subagents: Array<SubagentMigration>;
    commands: Array<CommandMigration>;
};
