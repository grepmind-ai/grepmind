import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type {
  AgentCommitGraphErrorPayload,
  AgentCommitGraphRequestPayload,
  AgentCommitGraphResponsePayload,
  AgentSnapshotArchiveLimits,
  AgentSnapshotExportErrorPayload,
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

const execFileAsync = promisify(execFile);
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_STDERR_LENGTH = 8_000;
type SourceRequestOperation = 'snapshot' | 'commit_graph';

export class AgentSourceRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'AgentSourceRequestError';
    this.code = code;
    this.retryable = retryable;
  }
}

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
      const project = await this.prepareSourceRequest(
        request,
        request.targetCommitSha,
        'snapshot',
      );
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

      const archive = await this.streamGitArchive(
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
      const project = await this.prepareSourceRequest(
        request,
        request.targetSha,
        'commit_graph',
      );
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

    const project = await this.prepareSourceRequest(
      request,
      request.toInclusiveSha,
      'commit_graph',
    );
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
    expectedHeadSha: string,
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
        (attachState.currentObservedHead.branch !== request.expectedBranch ||
          normalizeCommitSha(attachState.currentObservedHead.headCommitSha) !==
            expectedHeadSha)
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

      if (
        observedHead.branch !== request.expectedBranch ||
        observedHead.headCommitSha !== expectedHeadSha
      ) {
        throw new AgentSourceRequestError(
          `Binding ${request.bindingId} working tree head no longer matches ${request.expectedBranch}@${expectedHeadSha.slice(0, 12)}`,
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
    const matchingBranch = branches.find(
      (branch) => branch.repoBranchId === request.repoBranchId,
    );
    if (!matchingBranch) {
      throw new AgentSourceRequestError(
        `Binding ${request.bindingId} does not expose repo branch ${request.repoBranchId}`,
        'SNAPSHOT_SOURCE_STALE',
        false,
      );
    }

    if (
      request.expectedBranch &&
      matchingBranch.branch !== request.expectedBranch
    ) {
      throw new AgentSourceRequestError(
        `Repo branch ${request.repoBranchId} does not match ${request.expectedBranch}`,
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

  private async streamGitArchive(
    workspacePath: string,
    commitSha: string,
    archive: AgentSnapshotArchiveLimits,
    requestId: string,
    send: RealtimeSend,
  ): Promise<{ totalBytes: number; sha256: string }> {
    const prefix = `grepmind-agent-snapshot-${commitSha}/`;
    const child = spawn(
      'git',
      ['archive', '--format=zip', `--prefix=${prefix}`, commitSha],
      {
        cwd: workspacePath,
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    let processError: Error | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = truncate(`${stderr}${String(chunk)}`, MAX_STDERR_LENGTH);
    });
    const exitPromise = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        processError =
          error instanceof Error ? error : new Error(String(error));
        resolve();
      });
      child.once('close', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    const hash = createHash('sha256');
    let totalBytes = 0;
    let sequence = 0;
    let pending = Buffer.alloc(0);
    let tooLarge = false;

    try {
      for await (const rawChunk of child.stdout) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk);
        if (totalBytes + chunk.length > archive.maxBytes) {
          tooLarge = true;
          child.kill('SIGTERM');
          break;
        }

        totalBytes += chunk.length;
        hash.update(chunk);
        pending =
          pending.length === 0
            ? chunk
            : Buffer.concat([pending, chunk], pending.length + chunk.length);

        while (pending.length >= archive.chunkBytes) {
          const frame = pending.subarray(0, archive.chunkBytes);
          send('snapshot.export.chunk', {
            requestId,
            sequence,
            base64: frame.toString('base64'),
          });
          sequence += 1;
          pending = pending.subarray(archive.chunkBytes);
        }
      }
    } catch (error) {
      if (!tooLarge) {
        throw new AgentSourceRequestError(
          errorMessage(error),
          'SNAPSHOT_EXPORT_FAILED',
          true,
        );
      }
    }

    await exitPromise;

    if (tooLarge) {
      throw new AgentSourceRequestError(
        `Snapshot archive exceeded ${archive.maxBytes} bytes`,
        'SNAPSHOT_TOO_LARGE',
        false,
      );
    }

    if (processError) {
      throw new AgentSourceRequestError(
        errorMessage(processError),
        'SNAPSHOT_EXPORT_FAILED',
        true,
      );
    }

    if (exitCode !== 0) {
      const message = stderr.trim()
        ? stderr.trim()
        : `git archive exited with ${exitCode ?? `signal ${exitSignal ?? 'unknown'}`}`;
      throw new AgentSourceRequestError(
        message,
        'SNAPSHOT_EXPORT_FAILED',
        true,
      );
    }

    if (pending.length > 0) {
      send('snapshot.export.chunk', {
        requestId,
        sequence,
        base64: pending.toString('base64'),
      });
    }

    return {
      totalBytes,
      sha256: hash.digest('hex'),
    };
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

export function toSnapshotExportErrorPayload(
  requestId: string,
  error: unknown,
): AgentSnapshotExportErrorPayload {
  if (error instanceof AgentSourceRequestError) {
    return {
      requestId,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    requestId,
    code: 'SNAPSHOT_EXPORT_FAILED',
    message: errorMessage(error),
    retryable: true,
  };
}

export function toCommitGraphErrorPayload(
  requestId: string,
  error: unknown,
): AgentCommitGraphErrorPayload {
  if (error instanceof AgentSourceRequestError) {
    return {
      requestId,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    requestId,
    code: 'COMMIT_GRAPH_FAILED',
    message: errorMessage(error),
    retryable: true,
  };
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = (await execFileAsync('git', args, {
    cwd: workspacePath,
    encoding: 'utf8',
    env: gitEnv(),
    maxBuffer: 10 * 1024 * 1024,
  })) as { stdout: string };

  return stdout.trim();
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function normalizeCommitSha(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(normalized) ? normalized : null;
}

function operationFailedCode(operation: SourceRequestOperation): string {
  return operation === 'snapshot'
    ? 'SNAPSHOT_EXPORT_FAILED'
    : 'COMMIT_GRAPH_FAILED';
}

function isVerifyCommitMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (record.code !== 128) {
    return false;
  }

  const message = `${typeof record.stderr === 'string' ? record.stderr : ''}\n${
    typeof record.message === 'string' ? record.message : ''
  }`;
  return (
    message.includes('Needed a single revision') ||
    message.includes('not a valid object name') ||
    message.includes('unknown revision') ||
    message.includes('bad revision')
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message || 'Unknown agent source request failure');
}

function truncate(value: string, maxLength = MAX_ERROR_MESSAGE_LENGTH): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
