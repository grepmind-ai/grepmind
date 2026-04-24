import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';
import {
  RealtimeWebSocket,
  SOCKET_OPEN_STATE,
  buildRealtimeUrl,
} from './realtime/connection.js';
import { createHeartbeatPayload } from './realtime/heartbeat.js';
import { computeReconnectDelay, DEFAULT_RECONNECT_BASE_MS } from './realtime/reconnect-policy.js';
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
  private readonly accessToken?: string;
  private readonly apiKey?: string;
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
  private heartbeatMs: number;
  private stopCommandId: string | null = null;
  private readonly pendingSearchRuns = new Map<string, PendingSearchRunRequest>();

  constructor(options: AgentBackendRealtimeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.accessToken = options.accessToken;
    this.apiKey = options.apiKey;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.protocolVersion = options.protocolVersion ?? 'v1';
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.logger = options.logger ?? noopAgentLogger;
    this.capabilities = options.capabilities ?? {};
    this.onStopRequested = options.onStopRequested;
    this.onIndexSearchRequested = options.onIndexSearchRequested;
    this.searchRequestTimeoutMs = options.searchRequestTimeoutMs ?? DEFAULT_SEARCH_REQUEST_TIMEOUT_MS;
  }

  start(bindings: AgentBackendRealtimeBinding[]): void {
    if (this.started || !RealtimeWebSocket) {
      if (!RealtimeWebSocket) {
        this.logger.warn('runtime', 'Global WebSocket is unavailable; agent realtime transport is disabled');
      }
      return;
    }

    this.started = true;
    this.bindings = [...bindings];
    this.connect();
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
    this.rejectPendingSearchRuns('Agent realtime client stopped before search completed');
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
      throw new AgentRealtimeSearchError(request.error, 'CONTRACT_MISMATCH');
    }

    if (this.ws?.readyState !== SOCKET_OPEN_STATE) {
      throw new AgentRealtimeSearchError('Agent realtime socket is not connected', 'NOT_CONNECTED');
    }
    if (this.pendingSearchRuns.has(request.value.requestId)) {
      throw new AgentRealtimeSearchError(
        `Search request ${request.value.requestId} is already in flight`,
        'DUPLICATE_REQUEST',
      );
    }

    const timeoutMs = Math.max(options.timeoutMs ?? this.searchRequestTimeoutMs, 1_000);
    return new Promise<SearchResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSearchRuns.delete(request.value.requestId);
        reject(
          new AgentRealtimeSearchError(
            `Timed out waiting for search.run.response for ${request.value.requestId}`,
            'TIMEOUT',
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

  private connect(): void {
    if (!RealtimeWebSocket || this.stopping || !this.started) {
      return;
    }

    const ws = new RealtimeWebSocket(buildRealtimeUrl(this.baseUrl, this.accessToken, this.apiKey));
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
      this.rejectPendingSearchRuns('Agent realtime socket closed before search completed');
      if (!this.stopping && this.started) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose handles retries.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.started) {
      return;
    }

    const delayMs = computeReconnectDelay(this.reconnectBaseMs, this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
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
      resolvePendingSearchRun: (response) => this.resolvePendingSearchRun(response),
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
      this.logger.warn('runtime', `Ignoring unexpected search.run.response for ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingSearchRuns.delete(response.requestId);
    pending.resolve(response);
  }

  private rejectPendingSearchRun(error: SearchErrorPayload): void {
    const pending = this.pendingSearchRuns.get(error.requestId);
    if (!pending) {
      this.logger.warn('runtime', `Ignoring unexpected search.run.error for ${error.requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingSearchRuns.delete(error.requestId);
    pending.reject(new AgentRealtimeSearchError(error.message, error.code));
  }

  private rejectPendingSearchRuns(message: string): void {
    for (const pending of this.pendingSearchRuns.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentRealtimeSearchError(message, 'CONNECTION_CLOSED'));
    }
    this.pendingSearchRuns.clear();
  }
}
