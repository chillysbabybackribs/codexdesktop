export type ExternalAgentConfigDetectParams = {
    /**
     * If true, include detection under the user's home directory.
     */
    includeHome?: boolean;
    /**
     * Zero or more working directories to include for repo-scoped detection.
     */
    cwds?: Array<string> | null;
};
