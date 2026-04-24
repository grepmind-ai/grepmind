import type { AgentBackendClient } from '../../backend/agent-backend-client.js';
import type { HeadSyncResponse } from '../../backend/contracts/index.js';
import type { AgentLogger } from '../../logging/agent-logger.js';
import type { ObservedLocalHead } from '../local-head-service.js';
import type { ActiveAttachState, QueuedHead } from './types.js';

export interface SyncHeadInput {
  backend: AgentBackendClient;
  bindingId: number;
  state: ActiveAttachState;
  observedHead: ObservedLocalHead;
  deviceId: string;
  logger: AgentLogger;
}

export async function syncHead(input: SyncHeadInput): Promise<HeadSyncResponse> {
  input.logger.trace(
    'publish',
    `request bindingId=${input.bindingId} attachEpoch=${input.state.attachEpoch} branch=${input.observedHead.branch} commit=${input.observedHead.headCommitSha}`,
  );
  try {
    return await input.backend.syncHead(input.bindingId, {
      deviceId: input.deviceId,
      attachEpoch: input.state.attachEpoch,
      branch: input.observedHead.branch,
      headCommitSha: input.observedHead.headCommitSha,
      remoteFingerprint: input.observedHead.remoteFingerprint,
    });
  } catch (error) {
    input.logger.error('publish', `syncHead failed for binding #${input.bindingId}`, error);
    throw error;
  }
}

export function updateSyncedState(
  stateByBindingId: Map<number, ActiveAttachState>,
  bindingId: number,
  state: ActiveAttachState,
  response: HeadSyncResponse,
  observedHead: ObservedLocalHead,
): void {
  const nextState: ActiveAttachState = {
    ...state,
    currentObservedHead: state.currentObservedHead,
    lastMaterializedHead: state.lastMaterializedHead,
    lastQueuedHead: state.lastQueuedHead,
  };

  if (response.decision === 'materialized') {
    nextState.lastMaterializedHead = {
      attachEpoch: state.attachEpoch,
      branch: observedHead.branch,
      headCommitSha: observedHead.headCommitSha,
      revisionId: response.revisionId,
      attachmentId: response.attachmentId,
    };
    nextState.lastQueuedHead = undefined;
    stateByBindingId.set(bindingId, nextState);
    return;
  }

  if (response.decision === 'queued') {
    nextState.lastQueuedHead = {
      attachEpoch: state.attachEpoch,
      branch: observedHead.branch,
      headCommitSha: observedHead.headCommitSha,
      jobId: response.jobId,
    };
    stateByBindingId.set(bindingId, nextState);
    return;
  }

  stateByBindingId.set(bindingId, nextState);
}

export interface LogHeadDecisionInput {
  stateByBindingId: Map<number, ActiveAttachState>;
  logger: AgentLogger;
  projectName: string;
  bindingId: number;
  observedHead: ObservedLocalHead;
  response: HeadSyncResponse;
  previousQueuedHead?: QueuedHead;
}

export function logHeadDecision(input: LogHeadDecisionInput): void {
  input.logger.trace(
    'publish',
    `response bindingId=${input.bindingId} decision=${input.response.decision} revisionId=${input.response.revisionId ?? 'none'} attachmentId=${input.response.attachmentId ?? 'none'} jobId=${input.response.jobId ?? 'none'}`,
  );

  const revisionRef = formatRevisionRef(input.observedHead.branch, input.observedHead.headCommitSha);
  switch (input.response.decision) {
    case 'queued': {
      const sameQueuedHead = input.previousQueuedHead
        && input.previousQueuedHead.attachEpoch === input.stateByBindingId.get(input.bindingId)?.attachEpoch
        && input.previousQueuedHead.branch === input.observedHead.branch
        && input.previousQueuedHead.headCommitSha === input.observedHead.headCommitSha
        && input.previousQueuedHead.jobId === input.response.jobId;
      if (sameQueuedHead) {
        input.logger.trace(
          'publish',
          `Head sync still queued for ${input.projectName} (#${input.bindingId}) at ${revisionRef}${input.response.jobId ? ` [job ${input.response.jobId}]` : ''}`,
        );
        return;
      }

      input.logger.info(
        'publish',
        `Queued head sync for ${input.projectName} (#${input.bindingId}) at ${revisionRef}${input.response.jobId ? ` [job ${input.response.jobId}]` : ''}`,
      );
      return;
    }
    case 'materialized':
      input.logger.success(
        'publish',
        `Head materialized for ${input.projectName} (#${input.bindingId}) at ${revisionRef}${input.response.revisionId != null ? ` as revision #${input.response.revisionId}` : ''}`,
      );
      return;
    case 'stale_rejected':
      input.logger.trace(
        'publish',
        `stale-rejected bindingId=${input.bindingId} revision=${revisionRef}`,
      );
      return;
    default:
      return;
  }
}

function formatRevisionRef(branch: string, commitSha: string): string {
  return `${branch}@${commitSha.slice(0, 12)}`;
}
