import type { TabManager } from './tab-manager.js';
export type BrowserControlServer = {
    socketPath: string;
    close: () => Promise<void>;
};
type TabsGetter = () => TabManager | null;
export declare function startBrowserControlServer(getTabs: TabsGetter): Promise<BrowserControlServer>;
export {};
