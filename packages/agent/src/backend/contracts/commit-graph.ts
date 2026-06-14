export interface AgentCommitGraphRequestBase {
  requestId: string;
  bindingId: number;
  repoId: number;
  repoBranchId: number;
  expectedAttachEpoch: number;
  expectedDeviceId: string;
  expectedBranch?: string;
}

export interface AgentNearestAttachedAncestorRequestPayload extends AgentCommitGraphRequestBase {
  kind: 'nearest_attached_ancestor';
  targetSha: string;
  attachedShas: string[];
  maxDepth: number;
}

export interface AgentFirstParentRangeRequestPayload extends AgentCommitGraphRequestBase {
  kind: 'first_parent_range';
  fromExclusiveSha: string;
  toInclusiveSha: string;
  maxCommits: number;
}

export type AgentCommitGraphRequestPayload =
  | AgentNearestAttachedAncestorRequestPayload
  | AgentFirstParentRangeRequestPayload;

export interface AgentNearestAttachedAncestorResponsePayload {
  requestId: string;
  kind: 'nearest_attached_ancestor';
  ancestorSha: string | null;
}

export interface AgentFirstParentRangeResponsePayload {
  requestId: string;
  kind: 'first_parent_range';
  commits: string[];
}

export type AgentCommitGraphResponsePayload =
  | AgentNearestAttachedAncestorResponsePayload
  | AgentFirstParentRangeResponsePayload;

export interface AgentCommitGraphErrorPayload {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
}
