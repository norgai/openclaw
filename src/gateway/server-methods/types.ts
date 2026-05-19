import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { createDefaultDeps } from "../../cli/deps.js";
import type { HealthSummary } from "../../commands/health.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronService } from "../../cron/service.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WizardSession } from "../../wizard/session.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { NodeRegistry } from "../node-registry.js";
import type { ConnectParams, ErrorShape, RequestFrame } from "../protocol/index.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "../server-broadcast.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";
import type { DedupeEntry } from "../server-shared.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type GatewayClient = {
  connect: ConnectParams;
  connId?: string;
  clientIp?: string;
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  /** Internal-only auth context that cannot be supplied through gateway RPC payloads. */
  internal?: {
    allowModelOverride?: boolean;
  };
};

export type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: ErrorShape,
  meta?: Record<string, unknown>,
) => void;

export type GatewayRequestContext = {
  deps: ReturnType<typeof createDefaultDeps>;
  cron: CronService;
  cronStorePath: string;
  execApprovalManager?: ExecApprovalManager;
  pluginApprovalManager?: ExecApprovalManager<PluginApprovalRequestPayload>;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  logHealth: { error: (message: string) => void };
  logGateway: SubsystemLogger;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribeAll: (nodeId: string) => void;
  hasConnectedMobileNode: () => boolean;
  hasExecApprovalClients?: (excludeConnId?: string) => boolean;
  disconnectClientsForDevice?: (deviceId: string, opts?: { role?: string }) => void;
  disconnectClientsUsingSharedGatewayAuth?: () => void;
  enforceSharedGatewayAuthGenerationForConfigWrite?: (nextConfig: OpenClawConfig) => void;
  nodeRegistry: NodeRegistry;
  agentRunSeq: Map<string, number>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatAbortedRuns: Map<string, number>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  addChatRun: (sessionId: string, entry: { sessionKey: string; clientRunId: string }) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  subscribeSessionEvents: (connId: string) => void;
  unsubscribeSessionEvents: (connId: string) => void;
  subscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeSessionMessageEvents: (connId: string, sessionKey: string) => void;
  unsubscribeAllSessionEvents: (connId: string) => void;
  getSessionEventSubscriberConnIds: () => ReadonlySet<string>;
  registerToolEventRecipient: (runId: string, connId: string) => void;
  dedupe: Map<string, DedupeEntry>;
  wizardSessions: Map<string, WizardSession>;
  findRunningWizard: () => string | null;
  purgeWizardSession: (id: string) => void;
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannel: (
    channel: import("../../channels/plugins/types.js").ChannelId,
    accountId?: string,
  ) => Promise<void>;
  stopChannel: (
    channel: import("../../channels/plugins/types.js").ChannelId,
    accountId?: string,
  ) => Promise<void>;
  markChannelLoggedOut: (
    channelId: import("../../channels/plugins/types.js").ChannelId,
    cleared: boolean,
    accountId?: string,
  ) => void;
  wizardRunner: (
    opts: import("../../commands/onboard-types.js").OnboardOptions,
    runtime: import("../../runtime.js").RuntimeEnv,
    prompter: import("../../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  /**
   * Send an `agent_control` frame directly to a specific connected client.
   * Used for out-of-band signals that are not broadcast events (e.g. bundle_unavailable).
   */
  sendAgentControl: (connId: string, frame: Record<string, unknown>) => void;
  /**
   * Signal that a job dispatch has started for the given connection.
   * Used to track active runs so that `bundle_invalidated` can queue reloads
   * instead of swapping the bundle mid-job.
   */
  markDispatchStarted: (connId: string) => void;
  /**
   * Signal that a job dispatch has completed (success or error) for the
   * given connection. When the active count drops to zero, any queued
   * `bundle_invalidated` reload callbacks are fired.
   */
  markDispatchEnded: (connId: string) => void;
  /**
   * Register a callback to run when the connection has no more active
   * dispatches. If there are no active dispatches right now, the callback is
   * called synchronously before this function returns.
   */
  onDispatchIdle: (connId: string, callback: () => void) => void;
  /**
   * Drop all dispatch state for a closed connection. Any queued idle callbacks
   * are discarded (not invoked) — the connection is gone and the reload would
   * target nothing. Must be called from the WS close handler.
   */
  cleanupDispatchState: (connId: string) => void;
  /**
   * Close the WebSocket connection for the given connId.
   * Used to forcibly close the socket after a pause-detected job rejection.
   */
  closeClient: (connId: string, code?: number, reason?: string) => void;
};

export type GatewayRequestOptions = {
  req: RequestFrame;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
};

export type GatewayRequestHandlerOptions = {
  req: RequestFrame;
  params: Record<string, unknown>;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  respond: RespondFn;
  context: GatewayRequestContext;
};

export type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

export type GatewayRequestHandlers = Record<string, GatewayRequestHandler>;
