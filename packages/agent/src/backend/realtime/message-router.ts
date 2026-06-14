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
      data?: Record<string, unknown>;
    };
    switch (message.type) {
      case 'hello.ack': {
        const heartbeatMs =
          typeof message.data?.heartbeatMs === 'number'
            ? message.data.heartbeatMs
            : input.currentHeartbeatMs;
        input.startHeartbeat(heartbeatMs);
        return;
      }
      case 'control.stop_requested': {
        const commandId =
          typeof message.data?.commandId === 'string'
            ? message.data.commandId
            : null;
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
        return;
      }
      case 'search.index.request': {
        const normalized = normalizeSearchIndexRequestPayload(message.data);
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
          input.logger.error(
            'runtime',
            'Local search.index.request failed',
            error,
          );
          input.ws?.close(1011, 'Local search.index.request failed');
        }
        return;
      }
      case 'snapshot.export.request': {
        const normalized = normalizeAgentSnapshotExportRequestPayload(
          message.data,
        );
        if (!normalized.ok) {
          const requestId = extractRealtimeRequestId(message.data);
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
        return;
      }
      case 'commit_graph.request': {
        const normalized = normalizeAgentCommitGraphRequestPayload(
          message.data,
        );
        if (!normalized.ok) {
          const requestId = extractRealtimeRequestId(message.data);
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
          input.logger.error(
            'runtime',
            'Local commit_graph.request failed',
            error,
          );
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
        return;
      }
      case 'search.run.response': {
        const normalized = normalizeSearchResponsePayload(message.data);
        if (!normalized.ok) {
          input.logger.warn(
            'runtime',
            `Ignoring invalid search.run.response payload: ${normalized.error}`,
          );
          return;
        }
        input.resolvePendingSearchRun(normalized.value);
        return;
      }
      case 'search.run.error': {
        const normalized = normalizeSearchErrorPayload(message.data);
        if (!normalized.ok) {
          input.logger.warn(
            'runtime',
            `Ignoring invalid search.run.error payload: ${normalized.error}`,
          );
          return;
        }
        input.rejectPendingSearchRun(normalized.value);
        return;
      }
      default:
        return;
    }
  } catch (error) {
    input.logger.warn(
      'runtime',
      `Failed to parse realtime message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
