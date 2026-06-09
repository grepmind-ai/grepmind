import type { AgentBackendClient } from '../backend/agent-backend-client.js';
import type {
  BranchDescriptor,
  EmbeddingProfileDescriptor,
  ProjectBindingDto,
  RegisterProjectRequest,
} from '../backend/contracts/index.js';
import type { LocalProjectRecord, LocalProjectSnapshot } from '../db/schema.js';
import type { AgentRepositories } from '../repositories/agent-repositories.js';
import type { AgentDatabase } from '../repositories/database.js';
import type { EmbeddingProfileRow } from '../repositories/embedding-profile-repository.js';
import type { ProjectBranchRow } from '../repositories/project-branch-repository.js';

export interface RegisterLocalProjectInput extends RegisterProjectRequest {
  workspacePath: string;
}

export interface UpsertProjectProjectionInput {
  project: ProjectBindingDto;
  branches?: BranchDescriptor[];
  embeddingProfiles?: EmbeddingProfileDescriptor[];
  workspacePath?: string;
  workspaceFingerprint?: string | null;
  lastSyncedAt?: string | null;
  localActiveBranch?: string | null;
}

export class ProjectRegistryService {
  constructor(
    private readonly db: AgentDatabase,
    private readonly repositories: AgentRepositories,
    private readonly backend: AgentBackendClient,
  ) {}

  async registerProject(
    input: RegisterLocalProjectInput,
  ): Promise<LocalProjectSnapshot> {
    const remoteProject = await this.backend.registerProject({
      remoteUrl: input.remoteUrl,
      repoFullName: input.repoFullName,
      defaultBranch: input.defaultBranch,
      displayName: input.displayName,
      workspaceFingerprint: input.workspaceFingerprint,
      preferredActiveBranch: input.preferredActiveBranch,
    });

    await this.upsertProjectProjection({
      project: remoteProject,
      branches: remoteProject.branches,
      embeddingProfiles: remoteProject.embeddingProfiles,
      workspacePath: input.workspacePath,
      workspaceFingerprint: input.workspaceFingerprint ?? null,
      localActiveBranch: input.preferredActiveBranch ?? null,
    });

    return this.requireProjectSnapshot(remoteProject.bindingId);
  }

  async refreshProject(bindingId: number): Promise<LocalProjectSnapshot> {
    const existing = await this.requireProject(bindingId);
    const remoteProject = await this.backend.getProject(bindingId);
    await this.upsertProjectProjection({
      project: remoteProject,
      branches: remoteProject.branches,
      embeddingProfiles: remoteProject.embeddingProfiles,
      workspacePath: existing.workspacePath,
      workspaceFingerprint: existing.workspaceFingerprint,
      lastSyncedAt: existing.lastSyncedAt,
      localActiveBranch: existing.activeBranch,
    });

    return this.requireProjectSnapshot(bindingId);
  }

  async unregisterProject(bindingId: number): Promise<void> {
    await this.requireProject(bindingId);
    await this.backend.unregisterProject(bindingId);
    await this.deleteLocalProject(bindingId);
  }

  async removeProject(bindingId: number): Promise<void> {
    await this.unregisterProject(bindingId);
  }

  async cleanProject(bindingId: number): Promise<LocalProjectRecord> {
    const project = await this.requireProject(bindingId);
    await this.deleteLocalProject(bindingId);
    return project;
  }

  async upsertProjectProjection(
    input: UpsertProjectProjectionInput,
  ): Promise<void> {
    const existing = await this.getProject(input.project.bindingId);
    const workspacePath = input.workspacePath ?? existing?.workspacePath;
    if (!workspacePath) {
      throw new Error(
        `workspacePath is required to materialize local project ${input.project.bindingId}`,
      );
    }

    const workspaceFingerprint =
      input.workspaceFingerprint ?? existing?.workspaceFingerprint ?? null;
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const lastSyncedAt = input.lastSyncedAt ?? existing?.lastSyncedAt ?? null;
    const branches = input.branches ?? input.project.branches;
    const embeddingProfiles =
      input.embeddingProfiles ?? input.project.embeddingProfiles;
    const localActiveBranch =
      input.localActiveBranch ??
      existing?.activeBranch ??
      input.project.activeBranch;
    const updatedAt = latestTimestamp(
      existing?.updatedAt,
      input.project.updatedAt,
    );
    const existingBranchRows = existing
      ? await this.repositories.projectBranches.listByBindingId(
          input.project.bindingId,
        )
      : [];
    const observedBranches = buildObservedBranchDescriptors({
      project: input.project,
      activeBranch: localActiveBranch,
      remoteBranches: branches,
      existingBranchRows,
    });

    await this.db.transaction(async (tx) => {
      await this.repositories.projects.upsertProjection(
        {
          bindingId: input.project.bindingId,
          repoId: input.project.repoId,
          userRepoId: input.project.accountRepoId ?? null,
          repoFullName: input.project.repoFullName,
          displayName: input.project.displayName,
          workspacePath,
          workspaceFingerprint,
          defaultBranch: input.project.defaultBranch,
          activeBranch: localActiveBranch,
          lastSyncedAt,
          createdAt,
          updatedAt,
        },
        tx,
      );

      await this.repositories.projectBranches.replaceForBinding(
        input.project.bindingId,
        updatedAt,
        observedBranches,
        tx,
      );
      await this.repositories.embeddingProfiles.replaceForBinding(
        input.project.bindingId,
        embeddingProfiles,
        tx,
      );
      await this.repositories.projectBindingSyncState.ensureIdle(
        input.project.bindingId,
        updatedAt,
        tx,
      );
    });
  }

  async observeBranch(bindingId: number, branch: string): Promise<void> {
    const project = await this.requireProject(bindingId);
    const existingBranchRows =
      await this.repositories.projectBranches.listByBindingId(bindingId);
    const updatedAt = latestTimestamp(
      project.updatedAt,
      new Date().toISOString(),
    );
    const observedBranches = buildObservedBranchDescriptors({
      project: {
        defaultBranch: project.defaultBranch,
        activeBranch: branch,
      },
      activeBranch: branch,
      remoteBranches: [],
      existingBranchRows,
    });

    await this.db.transaction(async (tx) => {
      await this.repositories.projects.upsertProjection(
        {
          bindingId: project.bindingId,
          repoId: project.repoId,
          userRepoId: project.accountRepoId,
          repoFullName: project.repoFullName,
          displayName: project.displayName,
          workspacePath: project.workspacePath,
          workspaceFingerprint: project.workspaceFingerprint,
          defaultBranch: project.defaultBranch,
          activeBranch: branch,
          lastSyncedAt: project.lastSyncedAt,
          createdAt: project.createdAt,
          updatedAt,
        },
        tx,
      );

      await this.repositories.projectBranches.replaceForBinding(
        bindingId,
        updatedAt,
        observedBranches,
        tx,
      );
    });
  }

  async listProjects(): Promise<LocalProjectRecord[]> {
    return (await this.repositories.projects.listAll()).map(
      toLocalProjectRecord,
    );
  }

  async getProject(bindingId: number): Promise<LocalProjectRecord | null> {
    const row = await this.repositories.projects.findByBindingId(bindingId);
    return row ? toLocalProjectRecord(row) : null;
  }

  async requireProject(bindingId: number): Promise<LocalProjectRecord> {
    const project = await this.getProject(bindingId);
    if (!project) {
      throw new Error(`Local project ${bindingId} is not registered`);
    }

    return project;
  }

  async getProjectSnapshot(
    bindingId: number,
  ): Promise<LocalProjectSnapshot | null> {
    const project = await this.getProject(bindingId);
    if (!project) {
      return null;
    }

    return {
      project,
      branches: await this.listBranches(bindingId),
      embeddingProfiles: await this.listEmbeddingProfiles(bindingId),
    };
  }

  async requireProjectSnapshot(
    bindingId: number,
  ): Promise<LocalProjectSnapshot> {
    const snapshot = await this.getProjectSnapshot(bindingId);
    if (!snapshot) {
      throw new Error(`Local project ${bindingId} is not registered`);
    }

    return snapshot;
  }

  async listBranches(bindingId: number): Promise<BranchDescriptor[]> {
    return (
      await this.repositories.projectBranches.listByBindingId(bindingId)
    ).map(toBranchDescriptor);
  }

  async listEmbeddingProfiles(
    bindingId: number,
  ): Promise<EmbeddingProfileDescriptor[]> {
    return (
      await this.repositories.embeddingProfiles.listByBindingId(bindingId)
    ).map(toEmbeddingProfileDescriptor);
  }

  async listSearchableBranches(bindingId: number): Promise<string[]> {
    return this.repositories.projectBranches.listSearchableBranchNames(
      bindingId,
    );
  }

  private async deleteLocalProject(bindingId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.repositories.codeChunks.deleteByBindingId(bindingId, tx);
      await this.repositories.docsChunks.deleteByBindingId(bindingId, tx);
      await this.repositories.projectRevisionFiles.deleteByBindingId(
        bindingId,
        tx,
      );
      await this.repositories.projectRevisionAttachments.deleteByBindingId(
        bindingId,
        tx,
      );
      await this.repositories.projectAttachmentSyncState.deleteByBindingId(
        bindingId,
        tx,
      );
      await this.repositories.projectRevisions.deleteByBindingId(bindingId, tx);
      await this.repositories.projectMaterializations.deleteByBindingId(
        bindingId,
        tx,
      );
      await this.repositories.projectBindingSyncState.deleteByBindingId(
        bindingId,
        tx,
      );
      await this.repositories.embeddingProfiles.deleteByBindingId(
        bindingId,
        tx,
      );
      await this.repositories.projectBranches.deleteByBindingId(bindingId, tx);
      await this.repositories.projects.deleteByBindingId(bindingId, tx);
    });
  }
}

function toLocalProjectRecord(
  row: NonNullable<
    Awaited<ReturnType<AgentRepositories['projects']['findByBindingId']>>
  >,
): LocalProjectRecord {
  return {
    ...row,
    accountRepoId: row.userRepoId,
    userRepoId: row.userRepoId,
  };
}

function toBranchDescriptor(row: ProjectBranchRow): BranchDescriptor {
  return {
    repoBranchId: row.repoBranchId,
    branch: row.branch,
    canonicalTrackingMode:
      row.canonicalTrackingMode as BranchDescriptor['canonicalTrackingMode'],
    isDefault: row.isDefault,
    viewerTracked: row.viewerTracked,
    isActiveForUser: row.isActiveForUser,
    sync: {
      status: row.syncStatus as BranchDescriptor['sync']['status'],
      lastSeenRemoteCommitSha: row.syncLastSeenRemoteCommitSha,
      lastSyncedCommitSha: row.syncLastSyncedCommitSha,
      lastSyncStartedAt: row.syncLastSyncStartedAt,
      lastSyncCompletedAt: row.syncLastSyncCompletedAt,
      errorMessage: row.syncErrorMessage,
    },
  };
}

function buildObservedBranchDescriptors(input: {
  project: Pick<ProjectBindingDto, 'defaultBranch' | 'activeBranch'>;
  activeBranch: string;
  remoteBranches: BranchDescriptor[];
  existingBranchRows: ProjectBranchRow[];
}): BranchDescriptor[] {
  const remoteBranchByName = new Map(
    input.remoteBranches.map((branch) => [branch.branch, branch]),
  );
  const existingBranchByName = new Map(
    input.existingBranchRows.map((row) => [row.branch, row]),
  );
  const observedBranchNames = new Set<string>([
    ...input.existingBranchRows.map((row) => row.branch),
    input.activeBranch,
  ]);

  if (observedBranchNames.size === 0) {
    return [];
  }

  return [...observedBranchNames]
    .sort((left, right) => left.localeCompare(right))
    .map((branchName) => {
      const remoteBranch = remoteBranchByName.get(branchName);
      const existingBranch = existingBranchByName.get(branchName);

      if (remoteBranch) {
        return {
          ...remoteBranch,
          viewerTracked: true,
          isActiveForUser: branchName === input.activeBranch,
        };
      }

      if (existingBranch) {
        return {
          ...toBranchDescriptor(existingBranch),
          viewerTracked: true,
          isActiveForUser: branchName === input.activeBranch,
        };
      }

      return {
        repoBranchId: null,
        branch: branchName,
        canonicalTrackingMode: 'manual',
        isDefault: branchName === input.project.defaultBranch,
        viewerTracked: true,
        isActiveForUser: branchName === input.activeBranch,
        sync: {
          status: 'idle',
          lastSeenRemoteCommitSha: null,
          lastSyncedCommitSha: null,
          lastSyncStartedAt: null,
          lastSyncCompletedAt: null,
          errorMessage: null,
        },
      } satisfies BranchDescriptor;
    });
}

function latestTimestamp(...values: Array<string | null | undefined>): string {
  const defined = values.filter((value): value is string => value != null);
  if (defined.length === 0) {
    return new Date().toISOString();
  }

  return defined.reduce((latest, value) => (value > latest ? value : latest));
}

function toEmbeddingProfileDescriptor(
  row: EmbeddingProfileRow,
): EmbeddingProfileDescriptor {
  return {
    target: row.target as EmbeddingProfileDescriptor['target'],
    profileVersion: row.profileVersion,
    model: row.model,
    dimensions: row.dimensions,
    embeddingSpace: row.embeddingSpace,
    artifactSchemaVersion: row.artifactSchemaVersion,
    distanceMetric:
      row.distanceMetric as EmbeddingProfileDescriptor['distanceMetric'],
    updatedAt: row.updatedAt,
  };
}
