export type EnvironmentAddParams = {
    environmentId: string;
    execServerUrl: string;
    /**
     * Optional WebSocket connection timeout. The server default applies when omitted.
     */
    connectTimeoutMs?: number | null;
};
