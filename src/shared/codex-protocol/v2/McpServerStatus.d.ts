import type { McpServerInfo } from "../McpServerInfo";
import type { Resource } from "../Resource";
import type { ResourceTemplate } from "../ResourceTemplate";
import type { Tool } from "../Tool";
import type { McpAuthStatus } from "./McpAuthStatus";
export type McpServerStatus = {
    name: string;
    serverInfo: McpServerInfo | null;
    tools: {
        [key in string]?: Tool;
    };
    resources: Array<Resource>;
    resourceTemplates: Array<ResourceTemplate>;
    authStatus: McpAuthStatus;
};
