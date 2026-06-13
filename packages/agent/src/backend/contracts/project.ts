import type { SearchTarget } from './search.js';

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

export type AgentGitHubAppRepairAction =
  | 'install_app'
  | 'update_installation'
  | 'update_repository_selection'
  | 'update_permissions'
  | 'retry_refresh'
  | 'resolve_repository_conflict';

export interface AgentGitHubAppRepair {
  action: AgentGitHubAppRepairAction;
  errorCode: string;
  message: string;
}

export interface ProjectBindingDto {
  bindingId: number;
  repoId: number;
  accountRepoId?: number | null;
  repoFullName: string;
  displayName: string;
  defaultBranch: string;
  activeBranch: string;
  branches: BranchDescriptor[];
  embeddingProfiles: EmbeddingProfileDescriptor[];
  updatedAt: string;
  githubAppRepair?: AgentGitHubAppRepair | null;
}

export type RegisterProjectSkippedReason = 'github_app_access_required';

export type RegisterProjectRegisteredResponse = ProjectBindingDto & {
  registered?: true;
};

export interface RegisterProjectSkippedResponse {
  registered: false;
  reason: RegisterProjectSkippedReason;
  connectionSource: 'github';
  repoFullName: string | null;
  remoteIdentity: string;
  githubAppRepair?: AgentGitHubAppRepair | null;
}

export interface RegisterProjectRequest {
  accountRepoId?: number;
  remoteUrl: string;
  repoFullName?: string;
  defaultBranch?: string;
  displayName: string;
  workspaceFingerprint: string;
  preferredActiveBranch?: string;
}

export type RegisterProjectResponse =
  | RegisterProjectRegisteredResponse
  | RegisterProjectSkippedResponse;

export interface ListProjectsResponse {
  items: ProjectBindingDto[];
}

export type GetProjectResponse = ProjectBindingDto;

export interface AgentProjectEvent {
  type: string;
  bindingId: number;
  repoId: number;
  repoBranchId?: number;
  branch?: string;
  revisionId?: number;
  profile?: EmbeddingProfileDescriptor;
  reason?: string;
  occurredAt: string;
}

export type AgentBackendBaseUrl = string | URL;
