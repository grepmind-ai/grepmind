export const AGENT_PROTOCOL_VERSION = 'v1';

export interface MaterializedHead {
  attachEpoch: number;
  branch: string;
  headCommitSha: string;
  revisionId: number | null;
  attachmentId: number | null;
}

export interface QueuedHead {
  attachEpoch: number;
  branch: string;
  headCommitSha: string;
  jobId?: string;
}

export interface ActiveAttachState {
  attachEpoch: number;
  deviceId: string;
  agentRepoRef: string;
  remoteFingerprint: string;
  currentObservedHead?: {
    branch: string;
    headCommitSha: string;
    observedAt: string;
  };
  lastMaterializedHead?: MaterializedHead;
  lastQueuedHead?: QueuedHead;
}

export interface BindingRealtimeState {
  bindingId: number;
  attachEpoch?: number;
  branch?: string;
  headCommitSha?: string;
  observedAt?: string;
}
