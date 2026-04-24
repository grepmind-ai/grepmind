export type AgentConnectionStatus = 'active' | 'stale' | 'disconnected';
export type AgentSourceTransportMode = 'snapshot';
export type AgentSourceStatus = 'inactive' | 'active' | 'error';

export interface AgentConnectionDto {
  connectionId: number;
  deviceId: string;
  deviceName: string | null;
  protocolVersion: string;
  status: AgentConnectionStatus;
  lastSeenAt: string | null;
  updatedAt: string;
}

export interface AgentGitSourceStatusDto {
  sourceId: number;
  repoId: number;
  bindingId: number;
  agentRepoRef: string;
  remoteFingerprint: string;
  transportMode: AgentSourceTransportMode;
  attachEpoch: number;
  status: AgentSourceStatus;
  errorMessage: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  connection: AgentConnectionDto;
}

export interface AttachAgentSourceRequest {
  deviceId: string;
  deviceName?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  agentRepoRef: string;
  remoteFingerprint: string;
  transportMode?: AgentSourceTransportMode;
}

export interface AttachAgentSourceResponse {
  source: AgentGitSourceStatusDto;
}

export interface GetBindingSourceResponse {
  source: AgentGitSourceStatusDto | null;
}

export type HeadSyncDecision =
  | 'materialized'
  | 'queued'
  | 'stale_rejected';

export interface HeadSyncRequest {
  deviceId: string;
  attachEpoch: number;
  branch: string;
  headCommitSha: string;
  observedAt?: string;
  remoteFingerprint?: string;
}

export interface HeadSyncResponse {
  decision: HeadSyncDecision;
  headCommitSha: string;
  revisionId: number | null;
  attachmentId: number | null;
  jobId?: string;
}
