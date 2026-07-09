import type { Config } from "./Config";
import type { ConfigLayer } from "./ConfigLayer";
import type { ConfigLayerMetadata } from "./ConfigLayerMetadata";
export type ConfigReadResponse = {
    config: Config;
    origins: {
        [key in string]?: ConfigLayerMetadata;
    };
    layers: Array<ConfigLayer> | null;
};
