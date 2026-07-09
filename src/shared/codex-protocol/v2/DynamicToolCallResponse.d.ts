import type { DynamicToolCallOutputContentItem } from "./DynamicToolCallOutputContentItem";
export type DynamicToolCallResponse = {
    contentItems: Array<DynamicToolCallOutputContentItem>;
    success: boolean;
};
