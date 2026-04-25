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
