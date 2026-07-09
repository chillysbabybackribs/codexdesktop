export type ExperimentalFeatureEnablementSetResponse = {
    /**
     * Feature enablement entries updated by this request.
     */
    enablement: {
        [key in string]?: boolean;
    };
};
