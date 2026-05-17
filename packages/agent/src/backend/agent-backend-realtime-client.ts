import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';
import {
  AGENT_ACCOUNT_SESSION_CAPABILITY,
  AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER,
  AGENT_ACCOUNT_SESSION_DEVICE_HEADER,
  AGENT_ACCOUNT_SESSION_HEADER,
  type AgentBackendAccountSessionProvider,
} from './account-session.js';
import {
  SOCKET_OPEN_STATE,
  buildRealtimeUrl,
  createRealtimeWebSocket,
} from './realtime/connection.js';
import { createHeartbeatPayload } from './realtime/heartbeat.js';
import {
  computeReconnectDelay,
  DEFAULT_RECONNECT_BASE_MS,
} from './realtime/reconnect-policy.js';
import { routeRealtimeMessage } from './realtime/message-router.js';
import {
  AgentRealtimeSearchError,
  normalizeSearchRequestPayload,
} from './realtime/search-bridge.js';
import type {
  AgentBackendRealtimeBinding,
  AgentBackendRealtimeClientOptions,
  PendingSearchRunRequest,
  WebSocketLike,
} from './realtime/types.js';
import type {
  SearchErrorPayload,
  SearchRequestPayload,
  SearchResponsePayload,
} from './contracts/index.js';

export type {
  AgentBackendRealtimeBinding,
  AgentBackendRealtimeClientOptions,
} from './realtime/types.js';
export { AgentRealtimeSearchError } from './realtime/search-bridge.js';

const DEFAULT_SEARCH_REQUEST_TIMEOUT_MS = 30_000;

export class AgentBackendRealtimeClient {
  private readonly baseUrl: string;
  private readonly accessToken?: AgentBackendRealtimeClientOptions['accessToken'];
  private readonly accountSession?: AgentBackendAccountSessionProvider;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly protocolVersion: string;
  private readonly reconnectBaseMs: number;
  private readonly logger: AgentLogger;
  private readonly capabilities: Record<string, unknown>;
  private readonly onStopRequested?: AgentBackendRealtimeClientOptions['onStopRequested'];
  private readonly onIndexSearchRequested?: AgentBackendRealtimeClientOptions['onIndexSearchRequested'];
  private readonly searchRequestTimeoutMs: number;
  private ws: WebSocketLike | null = null;
  private bindings: AgentBackendRealtimeBinding[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private started = false;
  private stopping = false;
  private connecting = false;
  private heartbeatMs: number;
  private stopCommandId: string | null = null;
  private reconnectingAfterTokenRefresh = false;
  private readonly pendingSearchRuns = new Map<
    string,
    PendingSearchRunRequest
  >();

  constructor(options: AgentBackendRealtimeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.accessToken = options.accessToken;
    this.accountSession = options.accountSession;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.protocolVersion = options.protocolVersion ?? 'v1';
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.logger = options.logger ?? noopAgentLogger;
    this.capabilities = options.capabilities ?? {};
    this.onStopRequested = options.onStopRequested;
    this.onIndexSearchRequested = options.onIndexSearchRequested;
    this.searchRequestTimeoutMs =
      options.searchRequestTimeoutMs ?? DEFAULT_SEARCH_REQUEST_TIMEOUT_MS;
    this.accessToken?.onRefresh?.(() => {
      this.reconnectWithFreshToken();
    });
  }

  start(bindings: AgentBackendRealtimeBinding[]): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.bindings = [...bindings];
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client stopping');
      this.ws = null;
    }
    this.rejectPendingSearchRuns(
      'Agent realtime client stopped before search completed',
    );
  }

  updateBindings(bindings: AgentBackendRealtimeBinding[]): void {
    this.bindings = [...bindings];
    if (this.ws?.readyState === SOCKET_OPEN_STATE) {
      this.sendHeartbeat();
    }
  }

  async runSearch(
    input: SearchRequestPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<SearchResponsePayload> {
    const request = normalizeSearchRequestPayload(input);
    if (!request.ok) {
      throw new AgentRealtimeSearchError(request.error, 'CONTRACT_MISMATCH', {
        retryable: false,
      });
    }

    if (this.ws?.readyState !== SOCKET_OPEN_STATE) {
      throw new AgentRealtimeSearchError(
        'Agent realtime socket is not connected',
        'NOT_CONNECTED',
        { retryable: true },
      );
    }
    if (this.pendingSearchRuns.has(request.value.requestId)) {
      throw new AgentRealtimeSearchError(
        `Search request ${request.value.requestId} is already in flight`,
        'DUPLICATE_REQUEST',
        { retryable: false },
      );
    }

    const timeoutMs = Math.max(
      options.timeoutMs ?? this.searchRequestTimeoutMs,
      1_000,
    );
    return new Promise<SearchResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSearchRuns.delete(request.value.requestId);
        reject(
          new AgentRealtimeSearchError(
            `Timed out waiting for search.run.response for ${request.value.requestId}`,
            'TIMEOUT',
            { retryable: true },
          ),
        );
      }, timeoutMs);

      this.pendingSearchRuns.set(request.value.requestId, {
        requestId: request.value.requestId,
        resolve,
        reject,
        timer,
      });

      this.send('search.run.request', request.value);
    });
  }

  private async connect(): Promise<void> {
    if (
      this.stopping ||
      !this.started ||
      this.connecting
    ) {
      return;
    }

    this.connecting = true;
    try {
      const accessToken = await this.resolveAccessToken();
      if (this.stopping || !this.started) {
        return;
      }
      const headers = await this.buildHandshakeHeaders(accessToken);

      const ws = createRealtimeWebSocket(buildRealtimeUrl(this.baseUrl), headers);
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.send('hello', {
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          protocolVersion: this.protocolVersion,
          capabilities: this.capabilities,
          bindings: this.bindings,
        });
      };

      ws.onmessage = (event) => {
        void this.handleMessage(event.data);
      };

      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
        }
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.rejectPendingSearchRuns(
          'Agent realtime socket closed before search completed',
        );
        if (!this.stopping && this.started) {
          if (this.reconnectingAfterTokenRefresh) {
            this.reconnectingAfterTokenRefresh = false;
            void this.connect();
          } else {
            this.scheduleReconnect();
          }
        }
      };

      ws.onerror = (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? '');
        if (message.includes('AGENT_ACCOUNT_SESSION_EXPIRED')) {
          void this.refreshAccountSessionForReconnect();
        }
        // onclose handles retries.
      };
    } catch (error) {
      this.logger.warn(
        'runtime',
        error instanceof Error
          ? `Failed to resolve OAuth token for realtime connection: ${error.message}`
          : 'Failed to resolve OAuth token for realtime connection',
      );
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.started) {
      return;
    }

    const delayMs = computeReconnectDelay(
      this.reconnectBaseMs,
      this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private async resolveAccessToken(): Promise<string | undefined> {
    return this.accessToken?.();
  }

  private async buildHandshakeHeaders(
    accessToken: string | undefined,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const accountSession = await this.accountSession?.();
    headers[AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER] =
      AGENT_ACCOUNT_SESSION_CAPABILITY;
    headers[AGENT_ACCOUNT_SESSION_DEVICE_HEADER] =
      accountSession?.deviceId ?? this.deviceId;
    if (accountSession?.token) {
      headers[AGENT_ACCOUNT_SESSION_HEADER] = accountSession.token;
    }

    return headers;
  }

  private async refreshAccountSessionForReconnect(): Promise<void> {
    if (!this.accountSession?.refresh) {
      return;
    }

    try {
      await this.accountSession.refresh();
    } catch (error) {
      this.logger.warn(
        'runtime',
        error instanceof Error
          ? `Agent account session refresh failed: ${error.message}`
          : 'Agent account session refresh failed',
      );
    }
  }

  private reconnectWithFreshToken(): void {
    if (this.stopping || !this.started) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connecting) {
      return;
    }

    if (!this.ws) {
      void this.connect();
      return;
    }

    this.reconnectingAfterTokenRefresh = true;
    this.ws.close(1000, 'OAuth token refreshed');
  }

  private async handleMessage(rawData: unknown): Promise<void> {
    await routeRealtimeMessage({
      rawData,
      logger: this.logger,
      ws: this.ws,
      currentHeartbeatMs: this.heartbeatMs,
      send: (type, data) => this.send(type, data),
      onStopRequested: this.onStopRequested,
      onIndexSearchRequested: this.onIndexSearchRequested,
      startHeartbeat: (heartbeatMs) => {
        this.startHeartbeat(heartbeatMs);
      },
      acceptStopCommand: (commandId) => this.acceptStopCommand(commandId),
      resolvePendingSearchRun: (response) =>
        this.resolvePendingSearchRun(response),
      rejectPendingSearchRun: (error) => this.rejectPendingSearchRun(error),
    });
  }

  private startHeartbeat(heartbeatMs: number): void {
    this.heartbeatMs = heartbeatMs;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, heartbeatMs);
    this.sendHeartbeat();
  }

  private sendHeartbeat(): void {
    this.send('heartbeat', createHeartbeatPayload(this.bindings));
  }

  private send(type: string, data: unknown): void {
    if (this.ws?.readyState !== SOCKET_OPEN_STATE) {
      return;
    }

    this.ws.send(JSON.stringify({ type, data }));
  }

  private acceptStopCommand(commandId: string): boolean {
    if (this.stopCommandId) {
      return false;
    }

    this.stopCommandId = commandId;
    this.stopping = true;
    return true;
  }

  private resolvePendingSearchRun(response: SearchResponsePayload): void {
    const pending = this.pendingSearchRuns.get(response.requestId);
    if (!pending) {
      this.logger.warn(
        'runtime',
        `Ignoring unexpected search.run.response for ${response.requestId}`,
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingSearchRuns.delete(response.requestId);
    pending.resolve(response);
  }

  private rejectPendingSearchRun(error: SearchErrorPayload): void {
    const pending = this.pendingSearchRuns.get(error.requestId);
    if (!pending) {
      this.logger.warn(
        'runtime',
        `Ignoring unexpected search.run.error for ${error.requestId}`,
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingSearchRuns.delete(error.requestId);
    pending.reject(new AgentRealtimeSearchError(error.message, error.code, {
      retryable: error.retryable,
      details: {
        nextAction: error.nextAction,
        retryAfterMs: error.retryAfterMs,
        quota: error.quota,
      },
    }));
  }

  private rejectPendingSearchRuns(message: string): void {
    for (const pending of this.pendingSearchRuns.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new AgentRealtimeSearchError(message, 'CONNECTION_CLOSED', {
          retryable: true,
        }),
      );
    }
    this.pendingSearchRuns.clear();
  }
}
