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

export interface ProjectBindingDto {
  bindingId: number;
  repoId: number;
  userRepoId?: number | null;
  repoFullName: string;
  displayName: string;
  defaultBranch: string;
  activeBranch: string;
  branches: BranchDescriptor[];
  embeddingProfiles: EmbeddingProfileDescriptor[];
  updatedAt: string;
}

export interface RegisterProjectRequest {
  userRepoId?: number;
  remoteFingerprint?: string;
  displayName: string;
  workspaceFingerprint?: string;
  preferredActiveBranch?: string;
}

export type RegisterProjectResponse = ProjectBindingDto;

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
