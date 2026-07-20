import type { ProviderCapabilities, ProviderId } from '../../shared/session-protocol/provider.js';
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js';
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js';
import type { Model } from '../../shared/session-protocol/index.js';
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js';
import type { ThreadTurnsListResponse } from '../../shared/codex-protocol/v2/ThreadTurnsListResponse.js';
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal.js';
import type { ThreadGoalClearResponse } from '../../shared/codex-protocol/v2/ThreadGoalClearResponse.js';
import type { ThreadGoalSetParams } from '../../shared/codex-protocol/v2/ThreadGoalSetParams.js';
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js';
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js';
import type { ThreadUnsubscribeResponse } from '../../shared/codex-protocol/v2/ThreadUnsubscribeResponse.js';
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js';
import type { PluginInstalledResponse } from '../../shared/codex-protocol/v2/PluginInstalledResponse.js';
import type { PluginListResponse } from '../../shared/codex-protocol/v2/PluginListResponse.js';
import type { PluginInstallParams } from '../../shared/codex-protocol/v2/PluginInstallParams.js';
import type { PluginInstallResponse } from '../../shared/codex-protocol/v2/PluginInstallResponse.js';
import type { PluginReadResponse } from '../../shared/codex-protocol/v2/PluginReadResponse.js';
import type {
  ChatAttachment,
  CodexListThreadTurnsParams,
  CodexPluginAppStatusResponse,
  SessionEvent,
} from '../../shared/ipc.js';
import type { ResumeHistoryConsumer } from '../codex/resume-history.js';

// The provider boundary (Claude-prep step 4): everything the app asks of a
// model runtime, as one interface. CodexClient is implementation #1; a Claude
// adapter implements the same surface and DECLARES its divergences through
// `capabilities` instead of patching call sites. Return types are currently
// the Codex wire shapes — when adapter #2 needs them to diverge, the neutral
// shapes get defined in shared/session-protocol and mapped here, mirroring
// the renderer-side quarantine.

export interface SessionProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  /** Spawn/initialize the runtime ahead of first use. Failure is non-fatal. */
  warmUp(): Promise<void>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  listModels(): Promise<Model[]>;
  listThreads(options?: {
    cursor?: string | null;
    cwd?: string | null;
  }): Promise<ThreadListResponse>;
  startThread(cwd?: string | null, model?: string | null): Promise<ThreadStartResponse>;
  resumeThread(threadId: string, history?: ResumeHistoryConsumer): Promise<ThreadResumeResponse>;
  listThreadTurns(params: CodexListThreadTurnsParams): Promise<ThreadTurnsListResponse>;
  sendMessage(
    threadId: string | null | undefined,
    text: string,
    cwd?: string | null,
    model?: string | null,
    attachments?: ChatAttachment[],
    effort?: ReasoningEffort | null,
    fastMode?: boolean,
  ): Promise<
    TurnStartResponse & {
      threadId: string;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
    }
  >;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  /** Only meaningful when capabilities.steering is true. */
  steerTurn(threadId: string, turnId: string, text: string): Promise<unknown>;
  /** Only meaningful when capabilities.compaction !== 'none'. */
  compactThread(threadId: string): Promise<{ started: boolean }>;
  unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse>;

  // Goal facet — gate on capabilities.goals.
  getGoal(threadId: string): Promise<ThreadGoal | null>;
  setGoal(params: ThreadGoalSetParams): Promise<ThreadGoal>;
  clearGoal(threadId: string): Promise<ThreadGoalClearResponse>;

  // Plugin facet — gate on capabilities.plugins.
  listInstalledPlugins(cwd?: string | null): Promise<PluginInstalledResponse>;
  listPlugins(cwd?: string | null): Promise<PluginListResponse>;
  readPlugin(params: PluginInstallParams): Promise<PluginReadResponse>;
  getPluginAppStatuses(
    appIds: string[],
    forceRefetch?: boolean,
  ): Promise<CodexPluginAppStatusResponse>;
  installPlugin(params: PluginInstallParams): Promise<PluginInstallResponse>;
  uninstallPlugin(pluginId: string): Promise<void>;

  /** Event stream in the shared notification vocabulary. */
  on(event: 'event', listener: (event: SessionEvent) => void): unknown;
}

export const codexCapabilities: ProviderCapabilities = {
  steering: true,
  reasoningEfforts: true,
  compaction: 'remote',
  toolTransport: 'dynamic-tools',
  resume: true,
  goals: true,
  plugins: true,
  processModel: 'shared-server',
  tokenTelemetry: true,
};
