import type { AgentLogger } from '../../logging/agent-logger.js';
import type {
  SearchErrorPayload,
  SearchResponsePayload,
} from '../contracts/index.js';
import { parseMessageData } from './connection.js';
import {
  normalizeSearchErrorPayload,
  normalizeSearchIndexRequestPayload,
  normalizeSearchResponsePayload,
} from './search-bridge.js';
import {
  extractRealtimeRequestId,
  normalizeAgentCommitGraphRequestPayload,
  normalizeAgentSnapshotExportRequestPayload,
} from './source-bridge.js';
import type {
  AgentBackendRealtimeClientOptions,
  RealtimeSend,
  WebSocketLike,
} from './types.js';

export interface RealtimeMessageRouterInput {
  rawData: unknown;
  logger: AgentLogger;
  ws: WebSocketLike | null;
  currentHeartbeatMs: number;
  send: RealtimeSend;
  onStopRequested?: AgentBackendRealtimeClientOptions['onStopRequested'];
  onIndexSearchRequested?: AgentBackendRealtimeClientOptions['onIndexSearchRequested'];
  onSnapshotExportRequested?: AgentBackendRealtimeClientOptions['onSnapshotExportRequested'];
  onCommitGraphRequested?: AgentBackendRealtimeClientOptions['onCommitGraphRequested'];
  startHeartbeat(heartbeatMs: number): void;
  acceptStopCommand(commandId: string): boolean;
  resolvePendingSearchRun(response: SearchResponsePayload): void;
  rejectPendingSearchRun(error: SearchErrorPayload): void;
}

type RealtimeMessageData = Record<string, unknown> | undefined;

export async function routeRealtimeMessage(
  input: RealtimeMessageRouterInput,
): Promise<void> {
  const payload = parseMessageData(input.rawData);
  if (!payload) {
    return;
  }

  try {
    const message = JSON.parse(payload) as {
      type?: unknown;
      data?: RealtimeMessageData;
    };
    await dispatchRealtimeMessage(input, message.type, message.data);
  } catch (error) {
    input.logger.warn(
      'runtime',
      `Failed to parse realtime message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function dispatchRealtimeMessage(
  input: RealtimeMessageRouterInput,
  type: unknown,
  data: RealtimeMessageData,
): Promise<void> {
  switch (type) {
    case 'hello.ack':
      handleHelloAck(input, data);
      return;
    case 'control.stop_requested':
      await handleStopRequested(input, data);
      return;
    case 'search.index.request':
      await handleSearchIndexRequest(input, data);
      return;
    case 'snapshot.export.request':
      await handleSnapshotExportRequest(input, data);
      return;
    case 'commit_graph.request':
      await handleCommitGraphRequest(input, data);
      return;
    case 'search.run.response':
      handleSearchRunResponse(input, data);
      return;
    case 'search.run.error':
      handleSearchRunError(input, data);
      return;
    default:
      return;
  }
}

function handleHelloAck(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): void {
  const heartbeatMs =
    typeof data?.heartbeatMs === 'number'
      ? data.heartbeatMs
      : input.currentHeartbeatMs;
  input.startHeartbeat(heartbeatMs);
}

async function handleStopRequested(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): Promise<void> {
  const commandId = typeof data?.commandId === 'string' ? data.commandId : null;
  if (!commandId) {
    return;
  }

  input.send('control.stop_ack', {
    commandId,
    accepted: true,
  });
  if (input.acceptStopCommand(commandId)) {
    await input.onStopRequested?.({ commandId });
  }
}

async function handleSearchIndexRequest(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): Promise<void> {
  const normalized = normalizeSearchIndexRequestPayload(data);
  if (!normalized.ok) {
    input.logger.error(
      'runtime',
      `Invalid search.index.request payload: ${normalized.error}`,
    );
    input.ws?.close(4002, 'Invalid search.index.request payload');
    return;
  }
  if (!input.onIndexSearchRequested) {
    input.logger.error(
      'runtime',
      'search.index.request received without a local search handler',
    );
    input.ws?.close(1011, 'search.index.request handler is unavailable');
    return;
  }

  try {
    const items = await input.onIndexSearchRequested(normalized.value);
    input.send('search.index.response', {
      requestId: normalized.value.requestId,
      items,
    });
  } catch (error) {
    input.logger.error('runtime', 'Local search.index.request failed', error);
    input.ws?.close(1011, 'Local search.index.request failed');
  }
}

async function handleSnapshotExportRequest(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): Promise<void> {
  const normalized = normalizeAgentSnapshotExportRequestPayload(data);
  if (!normalized.ok) {
    const requestId = extractRealtimeRequestId(data);
    if (!requestId) {
      input.logger.error(
        'runtime',
        `Invalid snapshot.export.request payload: ${normalized.error}`,
      );
      input.ws?.close(4002, 'Invalid snapshot.export.request payload');
      return;
    }

    input.send('snapshot.export.error', {
      requestId,
      code: 'CONTRACT_MISMATCH',
      message: normalized.error,
      retryable: false,
    });
    return;
  }
  if (!input.onSnapshotExportRequested) {
    input.send('snapshot.export.error', {
      requestId: normalized.value.requestId,
      code: 'SNAPSHOT_EXPORT_FAILED',
      message: 'snapshot.export.request handler is unavailable',
      retryable: true,
    });
    return;
  }

  try {
    await input.onSnapshotExportRequested(normalized.value, input.send);
  } catch (error) {
    input.logger.error(
      'runtime',
      'Local snapshot.export.request failed',
      error,
    );
    input.send(
      'snapshot.export.error',
      toRealtimeErrorPayload(
        normalized.value.requestId,
        error,
        'SNAPSHOT_EXPORT_FAILED',
        true,
      ),
    );
  }
}

async function handleCommitGraphRequest(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): Promise<void> {
  const normalized = normalizeAgentCommitGraphRequestPayload(data);
  if (!normalized.ok) {
    const requestId = extractRealtimeRequestId(data);
    if (!requestId) {
      input.logger.error(
        'runtime',
        `Invalid commit_graph.request payload: ${normalized.error}`,
      );
      input.ws?.close(4002, 'Invalid commit_graph.request payload');
      return;
    }

    input.send('commit_graph.error', {
      requestId,
      code: 'CONTRACT_MISMATCH',
      message: normalized.error,
      retryable: false,
    });
    return;
  }
  if (!input.onCommitGraphRequested) {
    input.send('commit_graph.error', {
      requestId: normalized.value.requestId,
      code: 'COMMIT_GRAPH_FAILED',
      message: 'commit_graph.request handler is unavailable',
      retryable: true,
    });
    return;
  }

  try {
    input.send(
      'commit_graph.response',
      await input.onCommitGraphRequested(normalized.value),
    );
  } catch (error) {
    input.logger.error('runtime', 'Local commit_graph.request failed', error);
    input.send(
      'commit_graph.error',
      toRealtimeErrorPayload(
        normalized.value.requestId,
        error,
        'COMMIT_GRAPH_FAILED',
        true,
      ),
    );
  }
}

function handleSearchRunResponse(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): void {
  const normalized = normalizeSearchResponsePayload(data);
  if (!normalized.ok) {
    input.logger.warn(
      'runtime',
      `Ignoring invalid search.run.response payload: ${normalized.error}`,
    );
    return;
  }
  input.resolvePendingSearchRun(normalized.value);
}

function handleSearchRunError(
  input: RealtimeMessageRouterInput,
  data: RealtimeMessageData,
): void {
  const normalized = normalizeSearchErrorPayload(data);
  if (!normalized.ok) {
    input.logger.warn(
      'runtime',
      `Ignoring invalid search.run.error payload: ${normalized.error}`,
    );
    return;
  }
  input.rejectPendingSearchRun(normalized.value);
}

function toRealtimeErrorPayload(
  requestId: string,
  error: unknown,
  fallbackCode: string,
  fallbackRetryable: boolean,
): {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
} {
  const record =
    error && typeof error === 'object'
      ? (error as { code?: unknown; retryable?: unknown })
      : null;
  const code =
    typeof record?.code === 'string' && record.code.trim()
      ? record.code.trim()
      : fallbackCode;
  const retryable =
    typeof record?.retryable === 'boolean'
      ? record.retryable
      : fallbackRetryable;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown realtime request failure';

  return {
    requestId,
    code,
    message: message.length > 2_000 ? message.slice(0, 2_000) : message,
    retryable,
  };
}
