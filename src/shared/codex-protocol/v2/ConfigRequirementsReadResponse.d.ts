import type { ConfigRequirements } from "./ConfigRequirements";
export type ConfigRequirementsReadResponse = {
    /**
     * Null if no requirements are configured (e.g. no requirements.toml/MDM entries).
     */
    requirements: ConfigRequirements | null;
};
