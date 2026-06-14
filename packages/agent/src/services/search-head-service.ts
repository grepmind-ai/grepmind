import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  SearchRequestPayload,
  SearchResponsePayload,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { LocalProjectRecord } from '../db/schema.js';
import { ProjectRevisionAttachmentRepository } from '../repositories/project-revision-attachment-repository.js';
import { LocalHeadService } from './local-head-service.js';
import type { ProjectRegistryService } from './project-registry-service.js';

const DEFAULT_SEARCH_HEAD_TIMEOUT_MS = 30_000;
const SEARCH_HEAD_REPAIR_TIMEOUT_RESERVE_MS = 5_000;
const SEARCH_HEAD_REPAIR_POLL_INTERVAL_MS = 1_000;

export interface SearchHeadCommandInput {
  bindingId?: number;
  workspacePath?: string;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  tags?: string[];
}

export interface SearchHeadResult extends SearchResponsePayload {
  scope: {
    bindingId: number;
    workspacePath: string;
    branch: string;
    headCommitSha: string;
    revisionId: number;
  };
}

export interface SearchHeadServiceOptions {
  projects: Pick<ProjectRegistryService, 'listProjects' | 'requireProject'>;
  revisionAttachments: Pick<
    ProjectRevisionAttachmentRepository,
    'findRevisionForHead'
  >;
  repairLocalHead?: (
    bindingId: number,
    target: SearchTarget | undefined,
    expectedHead: SearchHeadRepairExpectedHead,
    deadlineMs: number,
  ) => Promise<SearchHeadRepairResult>;
  searchTransport: {
    search(
      input: SearchRequestPayload,
      options?: { timeoutMs?: number },
    ): Promise<SearchResponsePayload>;
  };
  localHeadService?: LocalHeadService;
}

export interface SearchHeadRepairExpectedHead {
  branch: string;
  headCommitSha: string;
}

export type SearchHeadRepairResult =
  | { status: 'synced' }
  | { status: 'expired' }
  | {
      status: 'head_changed';
      branch: string | null;
      headCommitSha: string | null;
      detached: boolean;
    };

export class SearchHeadNotReadyError extends Error {
  readonly code = 'SEARCH_HEAD_QUEUED';
  readonly retryable = true;
  readonly details: {
    bindingId: number;
    branch: string;
    headCommitSha: string;
    target: SearchTarget | null;
    retryAfterMs: number;
    repairAttempts: number;
  };

  constructor(input: {
    bindingId: number;
    branch: string;
    headCommitSha: string;
    target: SearchTarget | undefined;
    repairAttempts: number;
  }) {
    super(
      `Local HEAD ${input.branch}@${input.headCommitSha} is queued for indexing; retry shortly.`,
    );
    this.name = 'SearchHeadNotReadyError';
    this.details = {
      bindingId: input.bindingId,
      branch: input.branch,
      headCommitSha: input.headCommitSha,
      target: input.target ?? null,
      retryAfterMs: SEARCH_HEAD_REPAIR_POLL_INTERVAL_MS,
      repairAttempts: input.repairAttempts,
    };
  }
}

export class SearchHeadChangedError extends Error {
  readonly code = 'SEARCH_HEAD_CHANGED';
  readonly retryable = true;
  readonly details: {
    bindingId: number;
    expected: SearchHeadRepairExpectedHead;
    actual: {
      branch: string | null;
      headCommitSha: string | null;
      detached: boolean;
    };
    target: SearchTarget | null;
  };

  constructor(input: {
    bindingId: number;
    expected: SearchHeadRepairExpectedHead;
    actual: {
      branch: string | null;
      headCommitSha: string | null;
      detached: boolean;
    };
    target: SearchTarget | undefined;
  }) {
    super(
      `Local HEAD changed while preparing search for ${input.expected.branch}@${input.expected.headCommitSha}; retry the search.`,
    );
    this.name = 'SearchHeadChangedError';
    this.details = {
      bindingId: input.bindingId,
      expected: input.expected,
      actual: input.actual,
      target: input.target ?? null,
    };
  }
}

export class SearchHeadService {
  private readonly localHeadService: LocalHeadService;

  constructor(private readonly options: SearchHeadServiceOptions) {
    this.localHeadService = options.localHeadService ?? new LocalHeadService();
  }

  async searchByLocalHead(
    input: SearchHeadCommandInput,
    options: { timeoutMs?: number } = {},
  ): Promise<SearchHeadResult> {
    const query = normalizeQuery(input.query);
    const target = normalizeTarget(input.target);
    const limit = normalizeLimit(input.limit);
    const threshold = normalizeThreshold(input.threshold);
    const tags = normalizeTags(input.tags);
    const project = await this.resolveProject(input);
    const observedHead = await this.localHeadService.readObservedHead(
      project.workspacePath,
    );

    if (!observedHead) {
      throw new Error(
        `Workspace ${project.workspacePath} is on a detached HEAD; search-head requires a branch checkout`,
      );
    }

    const revisionId = await this.resolveRevisionForObservedHead(
      project.bindingId,
      observedHead.branch,
      observedHead.headCommitSha,
      target,
      options.timeoutMs,
    );

    const response = await this.options.searchTransport.search(
      {
        requestId: randomUUID(),
        bindingId: project.bindingId,
        revisionId,
        query,
        target,
        limit,
        threshold,
        rerank: input.rerank ?? true,
        tags,
      },
      options,
    );

    return {
      ...response,
      scope: {
        bindingId: project.bindingId,
        workspacePath: project.workspacePath,
        branch: observedHead.branch,
        headCommitSha: observedHead.headCommitSha,
        revisionId,
      },
    };
  }

  private async resolveRevisionForObservedHead(
    bindingId: number,
    branch: string,
    headCommitSha: string,
    target: SearchTarget | undefined,
    timeoutMs: number | undefined,
  ): Promise<number> {
    const revisionId =
      await this.options.revisionAttachments.findRevisionForHead(
        bindingId,
        branch,
        headCommitSha,
      );

    if (revisionId != null) {
      return revisionId;
    }

    if (this.options.repairLocalHead) {
      const repairDeadlineMs = createRepairDeadlineMs(timeoutMs);
      const expectedHead = { branch, headCommitSha };
      let repairAttempts = 0;

      while (Date.now() < repairDeadlineMs) {
        repairAttempts += 1;
        const repairResult = await this.options.repairLocalHead(
          bindingId,
          target,
          expectedHead,
          repairDeadlineMs,
        );
        if (repairResult.status === 'expired') {
          break;
        }
        if (repairResult.status === 'head_changed') {
          throw new SearchHeadChangedError({
            bindingId,
            expected: expectedHead,
            actual: {
              branch: repairResult.branch,
              headCommitSha: repairResult.headCommitSha,
              detached: repairResult.detached,
            },
            target,
          });
        }
        const repairedRevisionId =
          await this.options.revisionAttachments.findRevisionForHead(
            bindingId,
            branch,
            headCommitSha,
          );

        if (repairedRevisionId != null) {
          return repairedRevisionId;
        }

        const remainingMs = repairDeadlineMs - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        await delay(Math.min(SEARCH_HEAD_REPAIR_POLL_INTERVAL_MS, remainingMs));
      }

      throw new SearchHeadNotReadyError({
        bindingId,
        branch,
        headCommitSha,
        target,
        repairAttempts,
      });
    }

    throw new Error(
      `Local HEAD ${branch}@${headCommitSha} is not synced yet, search cannot run on server for this commit.`,
    );
  }

  private async resolveProject(
    input: SearchHeadCommandInput,
  ): Promise<LocalProjectRecord> {
    if (input.bindingId != null) {
      return this.options.projects.requireProject(input.bindingId);
    }

    const scopePath = path.resolve(input.workspacePath ?? process.cwd());
    const projects = await this.options.projects.listProjects();
    const exactMatches = projects.filter((project) =>
      samePath(project.workspacePath, scopePath),
    );

    if (exactMatches.length === 1) {
      return exactMatches[0]!;
    }
    if (exactMatches.length > 1) {
      throw new Error(
        `Multiple local projects match ${scopePath}; use --binding-id to disambiguate`,
      );
    }

    const containingMatches = projects.filter((project) =>
      isPathWithin(project.workspacePath, scopePath),
    );
    if (containingMatches.length === 0) {
      throw new Error(`No local project is registered for ${scopePath}`);
    }

    const longestWorkspacePathLength = Math.max(
      ...containingMatches.map(
        (project) => path.resolve(project.workspacePath).length,
      ),
    );
    const narrowedMatches = containingMatches.filter(
      (project) =>
        path.resolve(project.workspacePath).length ===
        longestWorkspacePathLength,
    );

    if (narrowedMatches.length !== 1) {
      throw new Error(
        `Multiple local projects match ${scopePath}; use --binding-id to disambiguate`,
      );
    }

    return narrowedMatches[0]!;
  }
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error('--query is required');
  }

  return normalized;
}

function normalizeTarget(
  target: SearchTarget | undefined,
): SearchTarget | undefined {
  if (target == null) {
    return undefined;
  }
  if (target === 'code' || target === 'docs') {
    return target;
  }

  throw new Error('--target must be code or docs');
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit == null) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive number');
  }

  return limit;
}

function normalizeThreshold(threshold: number | undefined): number | undefined {
  if (threshold == null) {
    return undefined;
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('--threshold must be between 0 and 1');
  }

  return threshold;
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (tags == null) {
    return undefined;
  }
  if (!Array.isArray(tags)) {
    throw new TypeError('--tags must be an array');
  }

  const normalized = tags.map((tag) => tag.trim().toLowerCase());
  if (normalized.some((tag) => tag.length === 0)) {
    throw new Error('--tags must contain non-empty strings');
  }

  return [...new Set(normalized)];
}

function createRepairDeadlineMs(timeoutMs: number | undefined): number {
  const requestTimeoutMs = timeoutMs ?? DEFAULT_SEARCH_HEAD_TIMEOUT_MS;
  const repairBudgetMs = Math.max(
    0,
    requestTimeoutMs - SEARCH_HEAD_REPAIR_TIMEOUT_RESERVE_MS,
  );
  return Date.now() + repairBudgetMs;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathWithin(workspacePath: string, candidatePath: string): boolean {
  const relative = path.relative(
    path.resolve(workspacePath),
    path.resolve(candidatePath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}
