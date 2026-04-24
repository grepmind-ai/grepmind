import type { AgentBackendClient } from '../../backend/agent-backend-client.js';
import type { AgentLogger } from '../../logging/agent-logger.js';
import type { ObservedLocalHead } from '../local-head-service.js';
import { AGENT_PROTOCOL_VERSION, type ActiveAttachState } from './types.js';

export function clearObservedHead(
  stateByBindingId: Map<number, ActiveAttachState>,
  bindingId: number,
): void {
  const state = stateByBindingId.get(bindingId);
  if (!state?.currentObservedHead) {
    return;
  }

  stateByBindingId.set(bindingId, {
    ...state,
    currentObservedHead: undefined,
  });
}

export function recordObservedHead(
  stateByBindingId: Map<number, ActiveAttachState>,
  bindingId: number,
  state: ActiveAttachState,
  observedHead: ObservedLocalHead,
): ActiveAttachState {
  const nextState: ActiveAttachState = {
    ...state,
    currentObservedHead: {
      branch: observedHead.branch,
      headCommitSha: observedHead.headCommitSha,
      observedAt: observedHead.observedAt,
    },
  };
  stateByBindingId.set(bindingId, nextState);
  return nextState;
}

export interface EnsureAttachedInput {
  stateByBindingId: Map<number, ActiveAttachState>;
  backend: AgentBackendClient;
  bindingId: number;
  observedHead: ObservedLocalHead;
  deviceId: string;
  deviceName: string;
  logger: AgentLogger;
}

export async function ensureAttached(input: EnsureAttachedInput): Promise<ActiveAttachState> {
  const active = input.stateByBindingId.get(input.bindingId);

  if (!active) {
    return attachSource(input);
  }

  const mismatch = active.deviceId !== input.deviceId
    || active.agentRepoRef !== input.observedHead.agentRepoRef
    || active.remoteFingerprint !== input.observedHead.remoteFingerprint;

  if (mismatch) {
    input.logger.info(
      'attach',
      `Re-attaching source for binding #${input.bindingId}: local source fingerprint changed`,
    );
    return attachSource(input);
  }

  return active;
}

export async function attachSource(input: EnsureAttachedInput): Promise<ActiveAttachState> {
  input.logger.info(
    'attach',
    `Attaching source for binding #${input.bindingId} at ${formatRevisionRef(input.observedHead.branch, input.observedHead.headCommitSha)}`,
  );
  try {
    const attached = await input.backend.attachSource(input.bindingId, {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      capabilities: { sourceTransport: 'snapshot' },
      agentRepoRef: input.observedHead.agentRepoRef,
      remoteFingerprint: input.observedHead.remoteFingerprint,
      transportMode: 'snapshot',
    });

    const next: ActiveAttachState = {
      attachEpoch: attached.source.attachEpoch,
      deviceId: attached.source.connection.deviceId,
      agentRepoRef: attached.source.agentRepoRef,
      remoteFingerprint: attached.source.remoteFingerprint,
    };
    input.stateByBindingId.set(input.bindingId, next);

    input.logger.success(
      'attach',
      `Attached source for binding #${input.bindingId} with epoch ${next.attachEpoch}`,
    );

    return next;
  } catch (error) {
    input.logger.error('attach', `attachSource failed for binding #${input.bindingId}`, error);
    throw error;
  }
}

export function dropMissingBindings(
  stateByBindingId: Map<number, ActiveAttachState>,
  activeBindingIds: Set<number>,
): void {
  for (const bindingId of stateByBindingId.keys()) {
    if (!activeBindingIds.has(bindingId)) {
      stateByBindingId.delete(bindingId);
    }
  }
}

function formatRevisionRef(branch: string, commitSha: string): string {
  return `${branch}@${commitSha.slice(0, 12)}`;
}
