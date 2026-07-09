export type EnvironmentShellInfo = {
    /**
     * Stable shell name, for example `zsh`, `bash`, `powershell`, `sh`, or `cmd`.
     */
    name: string;
    /**
     * Target-native shell executable path or command name.
     */
    path: string;
};
