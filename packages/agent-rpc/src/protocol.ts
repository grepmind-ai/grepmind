export const AGENT_RUNTIME_PROTOCOL_VERSION = 1;

export type AgentCommandMode = 'runtime-only';
export type SearchTarget = 'code' | 'docs';

export type CanonicalTrackingMode =
  | 'default'
  | 'pinned'
  | 'manual'
  | 'disabled';
export type BranchSyncStatus =
  | 'idle'
  | 'queued'
  | 'fetching'
  | 'indexing'
  | 'ready'
  | 'error'
  | 'disabled';

export interface AgentRuntimeMeta {
  protocolVersion: number;
  instanceId: string;
  startedAt: string;
  pid: number;
  socketPath: string;
  token: string;
}

export interface AgentRuntimePingResult {
  protocolVersion: number;
  instanceId: string;
  startedAt: string;
  pid: number;
  dataDir: string;
}

export interface EmbeddingProfileDescriptor {
  target: SearchTarget;
  profileVersion: number;
  model: string;
  dimensions: number;
  embeddingSpace: string;
  artifactSchemaVersion: number;
  distanceMetric: 'cosine';
  updatedAt: string;
}

export interface BranchDescriptor {
  repoBranchId: number | null;
  branch: string;
  canonicalTrackingMode: CanonicalTrackingMode;
  isDefault: boolean;
  viewerTracked: boolean;
  isActiveForUser: boolean;
  sync: {
    status: BranchSyncStatus;
    lastSeenRemoteCommitSha?: string | null;
    lastSyncedCommitSha?: string | null;
    lastSyncStartedAt?: string | null;
    lastSyncCompletedAt?: string | null;
    errorMessage?: string | null;
  };
}

export interface LocalProjectRecord {
  bindingId: number;
  repoId: number;
  userRepoId: number | null;
  repoFullName: string;
  displayName: string;
  workspacePath: string;
  workspaceFingerprint: string | null;
  defaultBranch: string;
  activeBranch: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalProjectSnapshot {
  project: LocalProjectRecord;
  branches: BranchDescriptor[];
  embeddingProfiles: EmbeddingProfileDescriptor[];
}

export interface AgentStatusQuery {
  bindingId?: number;
  branch?: string;
  commitSha?: string;
  limit?: number;
}

export interface AgentStatusSnapshot {
  filters: {
    bindingId: number | null;
    branch: string | null;
    commitSha: string | null;
    limit: number;
  };
  attachments: Array<{
    bindingId: number;
    attachmentId: number;
    revisionId: number;
    branch: string;
    visibility: 'canonical' | 'binding_private';
    ownerBindingId: number | null;
    sourceKind: 'remote_branch' | 'agent_snapshot';
    commitSha: string;
    filesSynced: boolean;
  }>;
  payloads: Array<{
    bindingId: number;
    revisionId: number;
    commitSha: string;
    ingestedAt: string;
    fileCount: number;
    totalBytes: number;
    needsFilesSync: boolean;
  }>;
  materializations: Array<{
    bindingId: number;
    revisionId: number;
    branch: string;
    target: SearchTarget;
    profileVersion: number;
    artifactSchemaVersion: number;
    status: string;
    materializedAt: string;
  }>;
}

export interface SyncProjectResult {
  bindingId: number;
  revisionCount: number;
  materializedPlanCount: number;
  invalidationCount: number;
  syncedAt: string;
}

export interface RegisterProjectCommandResult {
  snapshot: LocalProjectSnapshot;
  projectionVersion: number;
}

export interface ListProjectsCommandResult {
  items: LocalProjectRecord[];
}

export interface SyncProjectCommandResult {
  results: SyncProjectResult[];
}

export interface CleanProjectCommandResult {
  project: LocalProjectRecord;
}

export interface SearchResultItem {
  chunkId: string;
  artifactRef: string | null;
  branch: string;
  target: SearchTarget;
  path: string;
  relativePath: string;
  previewText: string;
  score: number;
  symbol: {
    id: string;
    name: string;
    type: string;
    signature: string | null;
    docstring: string | null;
    startLine: number;
    endLine: number;
    parentSymbol: string | null;
  };
  tags: string[];
}

export interface SearchResponsePayload {
  requestId: string;
  items: SearchResultItem[];
  meta: {
    bindingId: number;
    revisionId: number;
    durationMs: number;
    totalResults: number;
  };
}

export interface RegisterProjectRpcParams {
  remoteUrl: string;
  repoFullName?: string;
  defaultBranch?: string;
  displayName: string;
  workspacePath: string;
  workspaceFingerprint: string;
  preferredActiveBranch?: string;
  idempotencyKey: string;
}

export interface SyncProjectRpcParams {
  bindingId?: number;
  targets?: SearchTarget[];
  idempotencyKey: string;
}

export interface UnbindProjectRpcParams {
  bindingId: number;
  idempotencyKey: string;
}

export interface ShutdownRpcParams {
  idempotencyKey: string;
}

export interface CleanProjectRpcParams {
  bindingId: number;
  idempotencyKey: string;
}

export interface SearchHeadRpcParams {
  bindingId?: number;
  workspacePath?: string;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  tags?: string[];
}

export interface SearchHeadRpcResult extends SearchResponsePayload {
  scope: {
    bindingId: number;
    workspacePath: string;
    branch: string;
    headCommitSha: string;
    revisionId: number;
  };
}

export interface AgentRpcMethodMap {
  ping: {
    params: Record<string, never> | undefined;
    result: AgentRuntimePingResult;
  };
  status: {
    params: AgentStatusQuery;
    result: AgentStatusSnapshot;
  };
  registerProject: {
    params: RegisterProjectRpcParams;
    result: RegisterProjectCommandResult;
  };
  listProjects: {
    params: Record<string, never> | undefined;
    result: ListProjectsCommandResult;
  };
  syncProject: {
    params: SyncProjectRpcParams;
    result: SyncProjectCommandResult;
  };
  unbindProject: {
    params: UnbindProjectRpcParams;
    result: Record<string, never>;
  };
  cleanProject: {
    params: CleanProjectRpcParams;
    result: CleanProjectCommandResult;
  };
  searchHead: {
    params: SearchHeadRpcParams;
    result: SearchHeadRpcResult;
  };
  shutdown: {
    params: ShutdownRpcParams;
    result: {
      accepted: true;
    };
  };
}

export type AgentRpcMethod = keyof AgentRpcMethodMap;

export interface AgentRpcError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface AgentRpcRequest<
  TMethod extends AgentRpcMethod = AgentRpcMethod,
> {
  id: string;
  method: TMethod;
  params: AgentRpcMethodMap[TMethod]['params'];
  timeoutMs?: number;
  protocolVersion: number;
  token?: string;
}

export interface AgentRpcSuccessResponse<
  TMethod extends AgentRpcMethod = AgentRpcMethod,
> {
  id: string;
  ok: true;
  result: AgentRpcMethodMap[TMethod]['result'];
}

export interface AgentRpcFailureResponse {
  id: string;
  ok: false;
  error: AgentRpcError;
}

export type AgentRpcResponse<TMethod extends AgentRpcMethod = AgentRpcMethod> =
  | AgentRpcSuccessResponse<TMethod>
  | AgentRpcFailureResponse;

export function isMutatingRpcMethod(method: AgentRpcMethod): boolean {
  return (
    method === 'registerProject' ||
    method === 'syncProject' ||
    method === 'unbindProject' ||
    method === 'cleanProject' ||
    method === 'shutdown'
  );
}
