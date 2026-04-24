import type { BranchDescriptor, EmbeddingProfileDescriptor, ProjectBindingDto } from './project.js';
import type { SearchTarget } from './search.js';

export interface BranchCursorState {
  branch: string;
  maxKnownAttachmentId: number;
}

export interface PendingRevisionState {
  attachmentId: number;
  revisionId: number;
  filesSynced?: boolean;
}

export interface RevisionTombstone {
  attachmentId: number;
  revisionId: number;
  reason: 'OUT_OF_SCOPE_BRANCH' | 'NO_LONGER_VISIBLE';
}

export interface LocalMaterializationState {
  revisionId: number;
  target: SearchTarget;
  profileVersion: number;
  artifactSchemaVersion: number;
  materializedAt: string;
}

export interface LocalProfileState {
  target: SearchTarget;
  profileVersion: number;
  dimensions: number;
  artifactSchemaVersion: number;
}

export interface SyncProjectLocalState {
  targets?: SearchTarget[];
  branchCursors?: BranchCursorState[];
  pendingRevisions?: PendingRevisionState[];
  materializations?: LocalMaterializationState[];
  profiles?: LocalProfileState[];
}

export interface SyncProjectRequest {
  cursor?: string;
  localState?: SyncProjectLocalState;
}

export interface RevisionDelta {
  attachmentId: number;
  revisionId: number;
  repoBranchId: number;
  branch: string;
  ref?: string | null;
  commitSha: string;
  ingestedAt: string;
  fileCount: number;
  totalBytes: number;
  visibility: 'canonical' | 'binding_private';
  ownerBindingId: number | null;
  sourceKind: 'remote_branch' | 'agent_snapshot';
  needsFilesSync: boolean;
  filesPage?: { limit: number };
}

export interface MaterializationPlan {
  revisionId: number;
  branch: string;
  target: SearchTarget;
  desiredProfileVersion: number;
  replaceRevisionId?: number | null;
  reason: 'INITIAL_SYNC' | 'PROFILE_CHANGED' | 'FORCED_REBUILD';
}

export interface InvalidationHint {
  target: SearchTarget;
  revisionId?: number;
  kind: 'DROP_MATERIALIZATION' | 'RECREATE_INDEX';
  reason: string;
}

export interface SyncProjectResponse {
  project: ProjectBindingDto;
  branches: BranchDescriptor[];
  embeddingProfiles: EmbeddingProfileDescriptor[];
  revisions: RevisionDelta[];
  materializationPlan: MaterializationPlan[];
  invalidations: InvalidationHint[];
  staleRevisions: RevisionTombstone[];
  nextCursor?: string;
}

export interface RevisionFileDto {
  fileId: number;
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged';
  contentHash?: string | null;
  sizeBytes?: number | null;
  lang?: string | null;
  flags?: string[] | null;
  artifactRef?: string | null;
  contentUri?: string | null;
}

export interface ListRevisionFilesPageResponse {
  revisionId: number;
  items: RevisionFileDto[];
  nextCursor?: string;
}

export type ArtifactBatchRef =
  | { kind: 'artifact_ref'; artifactRef: string; revisionId: number }
  | { kind: 'file_ref'; revisionId: number; fileId: number };

export interface GetArtifactsBatchRequest {
  target: SearchTarget | 'all';
  refs: ArtifactBatchRef[];
  includeBody?: boolean;
}

export interface CodeChunkImportDto {
  chunkId: string;
  path: string;
  language: string;
  symbolType?: string | null;
  symbolName?: string | null;
  signature?: string | null;
  parentSymbol?: string | null;
  scope?: unknown;
  startLine: number;
  endLine: number;
  docstring?: string | null;
  contentHash: string;
  previewText: string;
  embedding: number[];
  body?: string;
}

export interface DocsChunkImportDto {
  chunkId: string;
  path: string;
  sectionTitle?: string | null;
  headerChain?: string[] | null;
  headerLevel?: number | null;
  startLine: number;
  endLine: number;
  tags?: string[] | null;
  contentHash: string;
  previewText: string;
  embedding: number[];
  body?: string;
}

export type ArtifactImportItem =
  | {
      target: 'code';
      revisionId: number;
      fileId: number;
      artifactRef: string;
      contentUri?: string | null;
      checksum?: string | null;
      profileVersion: number;
      artifactSchemaVersion: number;
      chunks: CodeChunkImportDto[];
    }
  | {
      target: 'docs';
      revisionId: number;
      fileId: number;
      artifactRef: string;
      contentUri?: string | null;
      checksum?: string | null;
      profileVersion: number;
      artifactSchemaVersion: number;
      chunks: DocsChunkImportDto[];
    };

export interface GetArtifactsBatchResponse {
  items: ArtifactImportItem[];
  notFound: ArtifactBatchRef[];
  stale: ArtifactBatchRef[];
}
