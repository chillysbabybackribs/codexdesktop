import type { PathUri } from "../PathUri";
import type { EnvironmentShellInfo } from "./EnvironmentShellInfo";
export type EnvironmentInfoResponse = {
    shell: EnvironmentShellInfo;
    /**
     * Default working directory reported by the environment, as a canonical file URI.
     */
    cwd: PathUri | null;
};
