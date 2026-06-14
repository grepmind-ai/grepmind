export interface AgentSnapshotArchiveLimits {
  format: 'zip';
  maxBytes: number;
  maxFiles: number;
  maxExtractedBytes: number;
  chunkBytes: number;
}

export interface AgentSnapshotExportRequestPayload {
  requestId: string;
  bindingId: number;
  repoId: number;
  repoBranchId: number;
  jobId: string;
  targetCommitSha: string;
  expectedAttachEpoch: number;
  expectedDeviceId: string;
  expectedBranch?: string;
  archive: AgentSnapshotArchiveLimits;
}

export interface AgentSnapshotExportBeginPayload {
  requestId: string;
  format: 'zip';
  commitSha: string;
  chunkBytes: number;
}

export interface AgentSnapshotExportChunkPayload {
  requestId: string;
  sequence: number;
  base64: string;
}

export interface AgentSnapshotExportEndPayload {
  requestId: string;
  totalBytes: number;
  sha256: string;
}

export interface AgentSnapshotExportErrorPayload {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export type AgentSnapshotExportFramePayload =
  | AgentSnapshotExportBeginPayload
  | AgentSnapshotExportChunkPayload
  | AgentSnapshotExportEndPayload
  | AgentSnapshotExportErrorPayload;

export type AgentSnapshotExportFrameType =
  | 'snapshot.export.begin'
  | 'snapshot.export.chunk'
  | 'snapshot.export.end'
  | 'snapshot.export.error';
