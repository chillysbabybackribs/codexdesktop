/**
 * Stop filesystem watch notifications for a prior `fs/watch`.
 */
export type FsUnwatchParams = {
    /**
     * Watch identifier previously provided to `fs/watch`.
     */
    watchId: string;
};
