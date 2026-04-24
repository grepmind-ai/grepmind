import type { PGlite } from '@electric-sql/pglite';
import type { BranchDescriptor, EmbeddingProfileDescriptor } from '../backend/contracts/index.js';

export type AgentDb = PGlite;

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
