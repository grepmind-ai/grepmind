import type { AgentBackendRealtimeBinding } from './types.js';

export interface RealtimeHeartbeatPayload {
  occurredAt: string;
  bindings: AgentBackendRealtimeBinding[];
}

export function createHeartbeatPayload(
  bindings: AgentBackendRealtimeBinding[],
): RealtimeHeartbeatPayload {
  return {
    occurredAt: new Date().toISOString(),
    bindings,
  };
}
