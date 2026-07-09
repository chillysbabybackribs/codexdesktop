import type { Turn } from "./Turn";
export type TurnsPage = {
    data: Array<Turn>;
    nextCursor: string | null;
    backwardsCursor: string | null;
};
