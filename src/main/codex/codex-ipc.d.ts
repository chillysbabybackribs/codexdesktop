import { type BrowserWindow } from 'electron';
import { CodexClient } from './codex-client.js';
export declare function registerCodexIpc(getWindow: () => BrowserWindow | null): CodexClient;
