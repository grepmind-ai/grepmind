import path from 'node:path';
import type {
  AgentCommitGraphRequestPayload,
  AgentCommitGraphResponsePayload,
  AgentSnapshotExportRequestPayload,
} from '../backend/contracts/index.js';
import type { RealtimeSend } from '../backend/realtime/types.js';
import type { LocalProjectRecord } from '../db/schema.js';
import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';
import {
  LocalHeadService,
  type ObservedLocalSource,
} from './local-head-service.js';
import type { ProjectRegistryService } from './project-registry-service.js';
import type { ActiveAttachState } from './revision-publication/types.js';
import {
  AgentSourceRequestError,
  errorMessage,
  isVerifyCommitMissingObjectError,
  normalizeCommitSha,
  operationFailedCode,
  runGit,
  streamGitArchive,
  toSnapshotExportErrorPayload,
  type SourceRequestOperation,
} from './agent-source-request-utils.js';

export {
  AgentSourceRequestError,
  toCommitGraphErrorPayload,
  toSnapshotExportErrorPayload,
} from './agent-source-request-utils.js';

export interface AgentSourceRequestServiceOptions {
  projects: ProjectRegistryService;
  deviceId: string;
  logger?: AgentLogger;
  getAttachState(bindingId: number): ActiveAttachState | null;
}

export class AgentSourceRequestService {
  private readonly projects: ProjectRegistryService;
  private readonly deviceId: string;
  private readonly logger: AgentLogger;
  private readonly getAttachState: (
    bindingId: number,
  ) => ActiveAttachState | null;
  private readonly localHeadService = new LocalHeadService();

  constructor(options: AgentSourceRequestServiceOptions) {
    this.projects = options.projects;
    this.deviceId = options.deviceId;
    this.logger = options.logger ?? noopAgentLogger;
    this.getAttachState = options.getAttachState;
  }

  async exportSnapshot(
    request: AgentSnapshotExportRequestPayload,
    send: RealtimeSend,
  ): Promise<void> {
    try {
      const project = await this.prepareSourceRequest(request, 'snapshot');
      const commitSha = await this.verifyCommit(
        project.workspacePath,
        request.targetCommitSha,
        'snapshot',
      );

      send('snapshot.export.begin', {
        requestId: request.requestId,
        format: 'zip',
        commitSha,
        chunkBytes: request.archive.chunkBytes,
      });

      const archive = await streamGitArchive(
        project.workspacePath,
        commitSha,
        request.archive,
        request.requestId,
        send,
      );

      send('snapshot.export.end', {
        requestId: request.requestId,
        totalBytes: archive.totalBytes,
        sha256: archive.sha256,
      });
    } catch (error) {
      const payload = toSnapshotExportErrorPayload(request.requestId, error);
      this.logger.warn(
        'runtime',
        `snapshot export failed requestId=${request.requestId} bindingId=${request.bindingId} code=${payload.code}`,
      );
      send('snapshot.export.error', payload);
    }
  }

  async queryCommitGraph(
    request: AgentCommitGraphRequestPayload,
  ): Promise<AgentCommitGraphResponsePayload> {
    if (request.kind === 'nearest_attached_ancestor') {
      const project = await this.prepareSourceRequest(request, 'commit_graph');
      await this.verifyCommit(
        project.workspacePath,
        request.targetSha,
        'commit_graph',
      );
      for (const attachedSha of request.attachedShas) {
        await this.verifyCommit(
          project.workspacePath,
          attachedSha,
          'commit_graph',
        );
      }

      return {
        requestId: request.requestId,
        kind: request.kind,
        ancestorSha: await this.findNearestAttachedAncestor(
          project.workspacePath,
          request.targetSha,
          request.attachedShas,
          request.maxDepth,
        ),
      };
    }

    const project = await this.prepareSourceRequest(request, 'commit_graph');
    await this.verifyCommit(
      project.workspacePath,
      request.fromExclusiveSha,
      'commit_graph',
    );
    await this.verifyCommit(
      project.workspacePath,
      request.toInclusiveSha,
      'commit_graph',
    );

    return {
      requestId: request.requestId,
      kind: request.kind,
      commits: await this.listFirstParentRangeOldestFirst(
        project.workspacePath,
        request.fromExclusiveSha,
        request.toInclusiveSha,
        request.maxCommits,
      ),
    };
  }

  private async prepareSourceRequest(
    request: Pick<
      AgentSnapshotExportRequestPayload,
      | 'bindingId'
      | 'repoId'
      | 'repoBranchId'
      | 'expectedAttachEpoch'
      | 'expectedDeviceId'
      | 'expectedBranch'
    >,
    operation: SourceRequestOperation,
  ): Promise<LocalProjectRecord> {
    let project: LocalProjectRecord;
    try {
      project = await this.projects.requireProject(request.bindingId);
    } catch {
      throw new AgentSourceRequestError(
        `Local project ${request.bindingId} is not registered`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }

    if (project.repoId !== request.repoId) {
      throw new AgentSourceRequestError(
        `Binding ${request.bindingId} is not attached to repo ${request.repoId}`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }

    const attachState = this.getAttachState(request.bindingId);
    if (!attachState) {
      throw new AgentSourceRequestError(
        `Binding ${request.bindingId} has no active attached source`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }

    if (
      attachState.attachEpoch !== request.expectedAttachEpoch ||
      attachState.deviceId !== request.expectedDeviceId ||
      this.deviceId !== request.expectedDeviceId ||
      path.resolve(attachState.agentRepoRef) !==
        path.resolve(project.workspacePath)
    ) {
      throw new AgentSourceRequestError(
        `Binding ${request.bindingId} source attachment is stale`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }

    await this.assertRepoBranchFence(request);

    if (request.expectedBranch) {
      if (
        attachState.currentObservedHead &&
        attachState.currentObservedHead.branch !== request.expectedBranch
      ) {
        throw new AgentSourceRequestError(
          `Binding ${request.bindingId} observed head is stale`,
          'SNAPSHOT_SOURCE_STALE',
          false,
        );
      }

      let observedHead;
      try {
        observedHead = await this.localHeadService.readObservedHead(
          project.workspacePath,
        );
      } catch (error) {
        throw new AgentSourceRequestError(
          errorMessage(error),
          operationFailedCode(operation),
          true,
        );
      }

      if (!observedHead) {
        throw new AgentSourceRequestError(
          `Binding ${request.bindingId} working tree is detached from ${request.expectedBranch}`,
          'SNAPSHOT_SOURCE_STALE',
          false,
        );
      }

      this.assertObservedSourceMatches(
        request.bindingId,
        observedHead,
        attachState,
        project.workspacePath,
      );

      if (observedHead.branch !== request.expectedBranch) {
        throw new AgentSourceRequestError(
          `Binding ${request.bindingId} working tree branch no longer matches ${request.expectedBranch}`,
          'SNAPSHOT_SOURCE_STALE',
          false,
        );
      }
    } else {
      let observedSource;
      try {
        observedSource = await this.localHeadService.readObservedSource(
          project.workspacePath,
        );
      } catch (error) {
        throw new AgentSourceRequestError(
          errorMessage(error),
          operationFailedCode(operation),
          true,
        );
      }

      this.assertObservedSourceMatches(
        request.bindingId,
        observedSource,
        attachState,
        project.workspacePath,
      );
    }

    return project;
  }

  private assertObservedSourceMatches(
    bindingId: number,
    observedSource: ObservedLocalSource,
    attachState: Pick<ActiveAttachState, 'remoteFingerprint'>,
    workspacePath: string,
  ): void {
    if (
      path.resolve(observedSource.agentRepoRef) !==
        path.resolve(workspacePath) ||
      observedSource.remoteFingerprint !== attachState.remoteFingerprint
    ) {
      throw new AgentSourceRequestError(
        `Binding ${bindingId} source attachment is stale`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }
  }

  private async assertRepoBranchFence(
    request: Pick<
      AgentSnapshotExportRequestPayload,
      'bindingId' | 'repoBranchId' | 'expectedBranch'
    >,
  ): Promise<void> {
    const branches = await this.projects.listBranches(request.bindingId);
    const matchingBranchById = branches.find(
      (branch) => branch.repoBranchId === request.repoBranchId,
    );
    if (matchingBranchById) {
      if (
        request.expectedBranch &&
        matchingBranchById.branch !== request.expectedBranch
      ) {
        throw new AgentSourceRequestError(
          `Repo branch ${request.repoBranchId} does not match ${request.expectedBranch}`,
          'SNAPSHOT_SOURCE_STALE',
          false,
        );
      }

      return;
    }

    if (!request.expectedBranch) {
      throw new AgentSourceRequestError(
        `Binding ${request.bindingId} does not expose repo branch ${request.repoBranchId}`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }

    const matchingBranchByName = branches.find(
      (branch) => branch.branch === request.expectedBranch,
    );
    if (matchingBranchByName?.repoBranchId != null) {
      throw new AgentSourceRequestError(
        `Local branch ${request.expectedBranch} is linked to repo branch ${matchingBranchByName.repoBranchId}, not ${request.repoBranchId}`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }
  }

  private async verifyCommit(
    workspacePath: string,
    commitSha: string,
    operation: SourceRequestOperation,
  ): Promise<string> {
    const normalizedCommitSha = normalizeCommitSha(commitSha);
    if (!normalizedCommitSha) {
      throw new AgentSourceRequestError(
        'commit SHA must be a full 40 or 64 character hex string',
        'CONTRACT_MISMATCH',
        false,
      );
    }

    try {
      const stdout = await runGit(workspacePath, [
        'rev-parse',
        '--verify',
        `${normalizedCommitSha}^{commit}`,
      ]);
      const verifiedCommitSha = normalizeCommitSha(stdout);
      if (!verifiedCommitSha) {
        throw new AgentSourceRequestError(
          `git rev-parse returned invalid SHA: ${stdout}`,
          operationFailedCode(operation),
          true,
        );
      }

      return verifiedCommitSha;
    } catch (error) {
      if (error instanceof AgentSourceRequestError) {
        throw error;
      }
      if (!isVerifyCommitMissingObjectError(error)) {
        throw new AgentSourceRequestError(
          errorMessage(error),
          operationFailedCode(operation),
          true,
        );
      }
      throw new AgentSourceRequestError(
        `Commit ${normalizedCommitSha} was not found`,
        operation === 'snapshot'
          ? 'SNAPSHOT_COMMIT_NOT_FOUND'
          : 'COMMIT_GRAPH_FAILED',
        false,
      );
    }
  }

  private async findNearestAttachedAncestor(
    workspacePath: string,
    targetSha: string,
    attachedShas: string[],
    maxDepth: number,
  ): Promise<string | null> {
    const attached = new Set(attachedShas);
    let currentSha: string | null = targetSha;
    let depth = 0;

    while (currentSha) {
      if (attached.has(currentSha)) {
        return currentSha;
      }
      if (depth >= maxDepth) {
        return null;
      }

      currentSha = await this.readFirstParent(workspacePath, currentSha);
      depth += 1;
    }

    return null;
  }

  private async listFirstParentRangeOldestFirst(
    workspacePath: string,
    fromExclusiveSha: string,
    toInclusiveSha: string,
    maxCommits: number,
  ): Promise<string[]> {
    const commitsNewestFirst: string[] = [];
    let currentSha: string | null = toInclusiveSha;

    while (currentSha && currentSha !== fromExclusiveSha) {
      commitsNewestFirst.push(currentSha);
      if (commitsNewestFirst.length > maxCommits) {
        throw new AgentSourceRequestError(
          `First-parent range exceeded ${maxCommits} commits`,
          'COMMIT_GRAPH_RANGE_TOO_LARGE',
          false,
        );
      }

      currentSha = await this.readFirstParent(workspacePath, currentSha);
    }

    if (currentSha !== fromExclusiveSha) {
      throw new AgentSourceRequestError(
        `${fromExclusiveSha} is not on the first-parent chain for ${toInclusiveSha}`,
        'COMMIT_GRAPH_FAILED',
        false,
      );
    }

    return commitsNewestFirst.reverse();
  }

  private async readFirstParent(
    workspacePath: string,
    commitSha: string,
  ): Promise<string | null> {
    try {
      const stdout = await runGit(workspacePath, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        commitSha,
      ]);
      const [, firstParent] = stdout.split(/\s+/);
      if (!firstParent) {
        return null;
      }

      const normalized = normalizeCommitSha(firstParent);
      if (!normalized) {
        throw new AgentSourceRequestError(
          `git rev-list returned invalid parent SHA: ${firstParent}`,
          'COMMIT_GRAPH_FAILED',
          true,
        );
      }

      return normalized;
    } catch (error) {
      if (error instanceof AgentSourceRequestError) {
        throw error;
      }
      throw new AgentSourceRequestError(
        errorMessage(error),
        'COMMIT_GRAPH_FAILED',
        true,
      );
    }
  }
}
