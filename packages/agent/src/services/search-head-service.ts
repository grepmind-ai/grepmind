import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  SearchRequestPayload,
  SearchResponsePayload,
  SearchResultItem,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { LocalProjectRecord } from '../db/schema.js';
import type { SearchExactQuery } from '../runtime/rpc/protocol.js';
import { ProjectRevisionAttachmentRepository } from '../repositories/project-revision-attachment-repository.js';
import { LocalHeadService } from './local-head-service.js';
import {
  DEFAULT_RG_TIMEOUT_MS,
  LocalRgSearchService,
} from './local-rg-search-service.js';
import type { ProjectRegistryService } from './project-registry-service.js';
import {
  createRgWarning,
  guardSearchSignal,
  isFatalLocalRgError,
  normalizeContextLines,
  normalizeLimit,
  normalizeQuery,
  normalizeTags,
  normalizeTarget,
  normalizeThreshold,
  withScope,
} from './search-head-exact-helpers.js';
import { mergeSearchResults } from './search-result-merge.js';

const DEFAULT_SEARCH_HEAD_TIMEOUT_MS = 30_000;
const SEARCH_HEAD_REPAIR_TIMEOUT_RESERVE_MS = 5_000;
const SEARCH_HEAD_REPAIR_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SEARCH_HEAD_LIMIT = 10;
const DEFAULT_RG_CONTEXT_LINES = 2;
const MAX_RG_CONTEXT_LINES = 10;
const MIN_SEARCH_SIGNAL_BUDGET_MS = 500;

export interface SearchHeadCommandInput {
  bindingId?: number;
  workspacePath?: string;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  tags?: string[];
  exact?: SearchExactQuery;
  path?: string;
  globs?: string[];
  contextLines?: number;
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
  localRgSearchService?: LocalRgSearchService;
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
  private readonly localRgSearchService: LocalRgSearchService;

  constructor(private readonly options: SearchHeadServiceOptions) {
    this.localHeadService = options.localHeadService ?? new LocalHeadService();
    this.localRgSearchService =
      options.localRgSearchService ?? new LocalRgSearchService();
  }

  async searchByLocalHead(
    input: SearchHeadCommandInput,
    options: { timeoutMs?: number } = {},
  ): Promise<SearchHeadResult> {
    const startedAt = Date.now();
    const query = normalizeQuery(input.query);
    const target = normalizeTarget(input.target);
    const effectiveTarget = target ?? 'code';
    const limit = normalizeLimit(input.limit);
    const threshold = normalizeThreshold(input.threshold);
    const tags = normalizeTags(input.tags);
    const contextLines = normalizeContextLines(input.contextLines, {
      defaultValue: DEFAULT_RG_CONTEXT_LINES,
      maxValue: MAX_RG_CONTEXT_LINES,
    });
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

    const requestId = randomUUID();
    const semanticPayload: SearchRequestPayload = {
      requestId,
      bindingId: project.bindingId,
      revisionId,
      query,
      target,
      limit,
      threshold,
      rerank: input.rerank ?? true,
      tags,
    };
    if (input.exact == null) {
      const response = await this.options.searchTransport.search(
        semanticPayload,
        options,
      );

      return withScope(response, {
        bindingId: project.bindingId,
        workspacePath: project.workspacePath,
        branch: observedHead.branch,
        headCommitSha: observedHead.headCommitSha,
        revisionId,
      });
    }

    let rgSkippedWarning =
      tags != null && tags.length > 0
        ? 'Local exact rg search is skipped when docs tags are provided; tags are semantic metadata.'
        : undefined;
    const rgEligible = rgSkippedWarning == null;
    const semanticRemainingMs = getRemainingSearchBudgetMs(
      startedAt,
      options.timeoutMs,
    );
    if (semanticRemainingMs < MIN_SEARCH_SIGNAL_BUDGET_MS) {
      throw new Error(
        'search-head timeout budget was exhausted before search could run for the resolved local HEAD',
      );
    }

    const semanticResult = await guardSearchSignal(() =>
      this.options.searchTransport.search(semanticPayload, {
        timeoutMs: semanticRemainingMs,
      }),
    );
    if (!semanticResult.ok) {
      throw semanticResult.error;
    }

    const exactSearchPaths = collectSemanticExactSearchPaths(
      semanticResult.value.items,
      input.path,
    );
    const rgRemainingMs = getRemainingSearchBudgetMs(
      startedAt,
      options.timeoutMs,
    );
    if (
      rgEligible &&
      exactSearchPaths.length > 0 &&
      rgRemainingMs < MIN_SEARCH_SIGNAL_BUDGET_MS
    ) {
      rgSkippedWarning =
        'Local exact rg search is skipped because the search timeout budget was exhausted by semantic search.';
    }
    const rgResult =
      rgSkippedWarning == null && exactSearchPaths.length > 0
        ? await guardSearchSignal(() =>
            this.localRgSearchService.search({
              workspacePath: project.workspacePath,
              branch: observedHead.branch,
              target: effectiveTarget,
              exact: input.exact!,
              path: input.path,
              paths: exactSearchPaths,
              globs: input.globs,
              contextLines,
              limit: limit ?? DEFAULT_SEARCH_HEAD_LIMIT,
              timeoutMs: Math.min(DEFAULT_RG_TIMEOUT_MS, rgRemainingMs),
            }),
          )
        : null;

    if (rgResult && !rgResult.ok && isFatalLocalRgError(rgResult.error)) {
      throw rgResult.error;
    }

    const rgWarning = createRgWarning(rgResult, rgSkippedWarning);
    const rgItems = rgResult?.ok ? rgResult.value.items : [];
    const rgWasUsed = rgEligible && rgResult?.ok === true;

    const mergedItems = mergeSearchResults({
      semanticItems: semanticResult.value.items,
      rgItems,
      limit: limit ?? DEFAULT_SEARCH_HEAD_LIMIT,
      contextLines,
    });

    return withScope(
      {
        requestId: semanticResult.value.requestId,
        items: mergedItems,
        meta: {
          bindingId: project.bindingId,
          revisionId,
          durationMs: Date.now() - startedAt,
          totalResults: mergedItems.length,
          semanticResults: semanticResult.value.items.length,
          rgResults: rgResult?.ok ? rgResult.value.stats.matchCount : 0,
          rgTruncated: rgResult?.ok
            ? rgResult.value.stats.truncated
            : undefined,
          rgSource: rgWasUsed ? 'working_tree' : undefined,
          rgWarning,
        },
      },
      {
        bindingId: project.bindingId,
        workspacePath: project.workspacePath,
        branch: observedHead.branch,
        headCommitSha: observedHead.headCommitSha,
        revisionId,
      },
    );
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

function createRepairDeadlineMs(timeoutMs: number | undefined): number {
  const requestTimeoutMs = timeoutMs ?? DEFAULT_SEARCH_HEAD_TIMEOUT_MS;
  const repairBudgetMs = Math.max(
    0,
    requestTimeoutMs - SEARCH_HEAD_REPAIR_TIMEOUT_RESERVE_MS,
  );
  return Date.now() + repairBudgetMs;
}

function collectSemanticExactSearchPaths(
  items: SearchResultItem[],
  pathFilter: string | undefined,
): string[] {
  const normalizedPathFilter = normalizeWorkspaceRelativePath(pathFilter);
  const paths = new Set<string>();
  for (const item of items) {
    const relativePath = normalizeWorkspaceRelativePath(item.relativePath);
    if (!relativePath) {
      continue;
    }
    if (
      normalizedPathFilter &&
      !isRelativePathWithinFilter(relativePath, normalizedPathFilter)
    ) {
      continue;
    }

    paths.add(relativePath);
  }

  return [...paths];
}

function normalizeWorkspaceRelativePath(value: string | undefined): string {
  return value?.trim().replaceAll(/^[/\\]+/g, '').replaceAll('\\', '/') ?? '';
}

function isRelativePathWithinFilter(
  relativePath: string,
  pathFilter: string,
): boolean {
  return (
    relativePath === pathFilter || relativePath.startsWith(`${pathFilter}/`)
  );
}

function getRemainingSearchBudgetMs(
  startedAt: number,
  timeoutMs: number | undefined,
): number {
  const requestTimeoutMs = timeoutMs ?? DEFAULT_SEARCH_HEAD_TIMEOUT_MS;
  return Math.max(0, startedAt + requestTimeoutMs - Date.now());
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
