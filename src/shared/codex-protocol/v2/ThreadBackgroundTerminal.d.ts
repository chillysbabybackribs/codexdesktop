import type { AbsolutePathBuf } from "../AbsolutePathBuf";
export type ThreadBackgroundTerminal = {
    itemId: string;
    processId: string;
    command: string;
    cwd: AbsolutePathBuf;
    osPid: number | null;
    cpuPercent: number | null;
    rssKb: bigint | null;
};
