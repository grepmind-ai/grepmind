import type { AgentLogger } from '../../logging/agent-logger.js';
import type { AgentBackendAccessTokenProvider } from '../agent-backend-client.js';
import type {
  SearchChunkPointer,
  SearchIndexRequestPayload,
  SearchResponsePayload,
} from '../contracts/index.js';

export interface AgentBackendRealtimeBinding {
  bindingId: number;
  attachEpoch?: number;
  branch?: string;
  headCommitSha?: string;
  observedAt?: string;
}

export interface AgentBackendRealtimeClientOptions {
  baseUrl: string;
  accessToken?: AgentBackendAccessTokenProvider;
  deviceId: string;
  deviceName: string;
  protocolVersion?: string;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
  logger?: AgentLogger;
  capabilities?: Record<string, unknown>;
  onStopRequested?: (payload: { commandId: string }) => void | Promise<void>;
  onIndexSearchRequested?: (
    payload: SearchIndexRequestPayload,
  ) => Promise<SearchChunkPointer[]>;
  searchRequestTimeoutMs?: number;
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((...args: any[]) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((...args: any[]) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface PendingSearchRunRequest {
  requestId: string;
  resolve: (response: SearchResponsePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type RealtimeSend = (type: string, data: unknown) => void;
