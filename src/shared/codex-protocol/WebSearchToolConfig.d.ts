import type { WebSearchContextSize } from "./WebSearchContextSize";
import type { WebSearchLocation } from "./WebSearchLocation";
export type WebSearchToolConfig = {
    context_size: WebSearchContextSize | null;
    allowed_domains: Array<string> | null;
    location: WebSearchLocation | null;
};
