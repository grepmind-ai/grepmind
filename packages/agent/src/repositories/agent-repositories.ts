import type { AgentDatabase } from './database.js';
import { AgentMetaRepository } from './agent-meta-repository.js';
import { CodeChunkRepository } from './code-chunk-repository.js';
import { DocsChunkRepository } from './docs-chunk-repository.js';
import { EmbeddingProfileRepository } from './embedding-profile-repository.js';
import { ProjectAttachmentSyncStateRepository } from './project-attachment-sync-state-repository.js';
import { ProjectBindingSyncStateRepository } from './project-binding-sync-state-repository.js';
import { ProjectBranchRepository } from './project-branch-repository.js';
import { ProjectMaterializationRepository } from './project-materialization-repository.js';
import { ProjectRepository } from './project-repository.js';
import { ProjectRevisionAttachmentRepository } from './project-revision-attachment-repository.js';
import { ProjectRevisionFileRepository } from './project-revision-file-repository.js';
import { ProjectRevisionRepository } from './project-revision-repository.js';

export interface AgentRepositories {
  agentMeta: AgentMetaRepository;
  projects: ProjectRepository;
  projectBranches: ProjectBranchRepository;
  embeddingProfiles: EmbeddingProfileRepository;
  projectBindingSyncState: ProjectBindingSyncStateRepository;
  projectRevisions: ProjectRevisionRepository;
  projectRevisionAttachments: ProjectRevisionAttachmentRepository;
  projectRevisionFiles: ProjectRevisionFileRepository;
  projectAttachmentSyncState: ProjectAttachmentSyncStateRepository;
  projectMaterializations: ProjectMaterializationRepository;
  codeChunks: CodeChunkRepository;
  docsChunks: DocsChunkRepository;
}

export function createAgentRepositories(db: AgentDatabase): AgentRepositories {
  return {
    agentMeta: new AgentMetaRepository(db),
    projects: new ProjectRepository(db),
    projectBranches: new ProjectBranchRepository(db),
    embeddingProfiles: new EmbeddingProfileRepository(db),
    projectBindingSyncState: new ProjectBindingSyncStateRepository(db),
    projectRevisions: new ProjectRevisionRepository(db),
    projectRevisionAttachments: new ProjectRevisionAttachmentRepository(db),
    projectRevisionFiles: new ProjectRevisionFileRepository(db),
    projectAttachmentSyncState: new ProjectAttachmentSyncStateRepository(db),
    projectMaterializations: new ProjectMaterializationRepository(db),
    codeChunks: new CodeChunkRepository(db),
    docsChunks: new DocsChunkRepository(db),
  };
}
