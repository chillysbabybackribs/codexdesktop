export type McpServerOauthLoginParams = {
    name: string;
    threadId?: string | null;
    scopes?: Array<string> | null;
    timeoutSecs?: bigint | null;
};
