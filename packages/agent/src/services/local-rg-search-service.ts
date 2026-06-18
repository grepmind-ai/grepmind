import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SearchTarget } from '../backend/contracts/index.js';
import type { SearchExactQuery } from '../runtime/rpc/protocol.js';
import { runRg } from './local-rg-search-runner.js';
import { parseUserGlobs } from './local-rg-globs.js';
import {
  LocalRgSearchError,
  type LocalRgSearchResult,
} from './local-rg-search-types.js';

export { LocalRgSearchError, type LocalRgSearchResult };

export const DEFAULT_RG_TIMEOUT_MS = 7_500;
const MAX_RG_PATTERN_LENGTH = 500;
const MAX_RG_PATTERN_COUNT = 20;
const MAX_RG_GLOB_COUNT = 20;
const MAX_RG_GLOB_LENGTH = 200;
const MAX_RG_PATH_COUNT = 200;
const MAX_RG_PATH_LENGTH = 500;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MAX_ABSOLUTE_MATCHES = 200;

export interface LocalRgSearchInput {
  workspacePath: string;
  branch: string;
  target?: SearchTarget;
  exact: SearchExactQuery;
  path?: string;
  paths?: string[];
  globs?: string[];
  contextLines?: number;
  limit: number;
  timeoutMs?: number;
}

interface ResolvedScope {
  workspaceRoot: string;
  searchPath: string;
  exists: boolean;
}

export class LocalRgSearchService {
  async search(input: LocalRgSearchInput): Promise<LocalRgSearchResult> {
    const exactPatterns = validateInput(input);
    const scope = await resolveScope(input.workspacePath, input.path);
    if (!scope.exists) {
      return createEmptyRgResult({
        warning: `Local rg path does not exist: ${input.path}`,
      });
    }

    const searchPaths = await resolveSearchPaths(scope, input.paths);
    if (searchPaths.length === 0) {
      return createEmptyRgResult({});
    }

    const target = input.target ?? 'code';
    return runRg({
      args: buildRgArgs(input, exactPatterns, searchPaths, target),
      branch: input.branch,
      regex: input.exact.regex === true,
      target,
      timeoutMs: Math.min(
        input.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS,
        DEFAULT_RG_TIMEOUT_MS,
      ),
      userGlobs:
        target === 'docs' ? parseUserGlobs(input.globs ?? []) : undefined,
      workspaceRoot: scope.workspaceRoot,
      maxMatches: Math.min(
        Math.max(input.limit * 5, input.limit),
        MAX_ABSOLUTE_MATCHES,
      ),
    });
  }
}

function createEmptyRgResult(input: { warning?: string }): LocalRgSearchResult {
  return {
    items: [],
    stats: {
      matchCount: 0,
      fileCount: 0,
      truncated: false,
      durationMs: 0,
    },
    warning: input.warning,
  };
}

async function resolveSearchPaths(
  scope: ResolvedScope,
  paths: string[] | undefined,
): Promise<string[]> {
  if (paths == null) {
    return [scope.searchPath];
  }

  const normalizedPaths = normalizeSearchPaths(paths);
  const resolvedPaths: string[] = [];
  for (const normalizedPath of normalizedPaths) {
    const searchPath = path.resolve(scope.workspaceRoot, normalizedPath);
    if (!isPathWithin(scope.workspaceRoot, searchPath)) {
      throw new LocalRgSearchError(
        'RG_PATH_OUTSIDE_WORKSPACE',
        'paths entries must stay inside the workspace',
      );
    }

    const resolved = await resolveExistingSearchPath(searchPath);
    if (!resolved) {
      continue;
    }
    if (!isPathWithin(scope.workspaceRoot, resolved)) {
      throw new LocalRgSearchError(
        'RG_PATH_OUTSIDE_WORKSPACE',
        'paths entries resolve outside the workspace',
      );
    }
    if (!isPathWithin(scope.searchPath, resolved)) {
      continue;
    }

    resolvedPaths.push(resolved);
  }

  return [...new Set(resolvedPaths)];
}

function normalizeSearchPaths(paths: string[]): string[] {
  const normalizedPaths: string[] = [];
  for (const candidate of paths) {
    const rawPath = candidate.trim();
    if (!rawPath) {
      continue;
    }
    if (path.isAbsolute(rawPath)) {
      throw new LocalRgSearchError(
        'RG_PATH_OUTSIDE_WORKSPACE',
        'paths entries must be relative to the workspace',
      );
    }
    const normalizedPath = rawPath
      .replaceAll(/^[/\\]+/g, '')
      .replaceAll('\\', '/');
    if (normalizedPath) {
      normalizedPaths.push(normalizedPath);
    }
  }

  return [...new Set(normalizedPaths)];
}

async function resolveExistingSearchPath(
  searchPath: string,
): Promise<string | null> {
  try {
    return await realpath(searchPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function validateInput(input: LocalRgSearchInput): string[] {
  const exactPatterns = normalizeExactPatterns(input.exact);
  validateContextLines(input.contextLines);
  validateGlobs(input.globs);
  validatePaths(input.paths);

  return exactPatterns;
}

function normalizeExactPatterns(exact: SearchExactQuery): string[] {
  const patterns =
    exact.pattern == null
      ? []
      : Array.isArray(exact.pattern)
        ? exact.pattern
        : [exact.pattern];
  const normalizedPatterns: string[] = [];
  for (const patternInput of patterns) {
    const pattern = patternInput.trim();
    if (!pattern) {
      throw new LocalRgSearchError(
        'RG_INVALID_INPUT',
        'exact.pattern entries must be non-empty strings',
      );
    }
    if (pattern.length > MAX_RG_PATTERN_LENGTH) {
      throw new LocalRgSearchError(
        'RG_INVALID_INPUT',
        `exact.pattern entries must be at most ${MAX_RG_PATTERN_LENGTH} characters`,
      );
    }

    normalizedPatterns.push(pattern);
  }

  const dedupedPatterns = [...new Set(normalizedPatterns)];
  if (dedupedPatterns.length === 0) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      'exact.pattern must contain at least one entry',
    );
  }
  if (dedupedPatterns.length > MAX_RG_PATTERN_COUNT) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      `exact.pattern must contain at most ${MAX_RG_PATTERN_COUNT} entries`,
    );
  }

  return dedupedPatterns;
}

function validateContextLines(contextLines: number | undefined): void {
  if (contextLines == null) {
    return;
  }
  if (
    !Number.isInteger(contextLines) ||
    contextLines < 0 ||
    contextLines > MAX_CONTEXT_LINES
  ) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      `contextLines must be an integer between 0 and ${MAX_CONTEXT_LINES}`,
    );
  }
}

function validateGlobs(globs: string[] | undefined): void {
  if (globs == null) {
    return;
  }
  if (globs.length > MAX_RG_GLOB_COUNT) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      `globs must contain at most ${MAX_RG_GLOB_COUNT} entries`,
    );
  }
  for (const glob of globs) {
    const normalizedGlob = glob.trim();
    if (
      !normalizedGlob ||
      normalizedGlob === '!' ||
      glob.length > MAX_RG_GLOB_LENGTH
    ) {
      throw new LocalRgSearchError(
        'RG_INVALID_INPUT',
        `globs entries must be non-empty and at most ${MAX_RG_GLOB_LENGTH} characters`,
      );
    }
  }
}

function validatePaths(paths: string[] | undefined): void {
  if (paths == null) {
    return;
  }
  if (paths.length > MAX_RG_PATH_COUNT) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      `paths must contain at most ${MAX_RG_PATH_COUNT} entries`,
    );
  }
  for (const pathEntry of paths) {
    const normalizedPath = pathEntry.trim();
    if (!normalizedPath || pathEntry.length > MAX_RG_PATH_LENGTH) {
      throw new LocalRgSearchError(
        'RG_INVALID_INPUT',
        `paths entries must be non-empty and at most ${MAX_RG_PATH_LENGTH} characters`,
      );
    }
  }
}

async function resolveScope(
  workspacePath: string,
  userPath: string | undefined,
): Promise<ResolvedScope> {
  const workspaceRoot = await realpath(path.resolve(workspacePath)).catch(
    () => {
      throw new LocalRgSearchError(
        'RG_WORKSPACE_NOT_FOUND',
        `Workspace path does not exist: ${workspacePath}`,
      );
    },
  );
  const normalizedPath = userPath?.trim().replaceAll(/^[/\\]+/g, '');
  if (!normalizedPath) {
    return {
      workspaceRoot,
      searchPath: workspaceRoot,
      exists: true,
    };
  }
  if (path.isAbsolute(userPath!.trim())) {
    throw new LocalRgSearchError(
      'RG_PATH_OUTSIDE_WORKSPACE',
      'path must be relative to the workspace',
    );
  }

  const searchPath = path.resolve(workspaceRoot, normalizedPath);
  if (!isPathWithin(workspaceRoot, searchPath)) {
    throw new LocalRgSearchError(
      'RG_PATH_OUTSIDE_WORKSPACE',
      'path must stay inside the workspace',
    );
  }

  return resolveExistingScope(workspaceRoot, searchPath);
}

async function resolveExistingScope(
  workspaceRoot: string,
  searchPath: string,
): Promise<ResolvedScope> {
  try {
    const realSearchPath = await realpath(searchPath);
    if (!isPathWithin(workspaceRoot, realSearchPath)) {
      throw new LocalRgSearchError(
        'RG_PATH_OUTSIDE_WORKSPACE',
        'path resolves outside the workspace',
      );
    }

    return {
      workspaceRoot,
      searchPath: realSearchPath,
      exists: true,
    };
  } catch (error) {
    if (error instanceof LocalRgSearchError) {
      throw error;
    }
    if (isNotFoundError(error)) {
      return {
        workspaceRoot,
        searchPath,
        exists: false,
      };
    }

    throw error;
  }
}

function buildRgArgs(
  input: LocalRgSearchInput,
  exactPatterns: string[],
  searchPaths: string[],
  target: SearchTarget,
): string[] {
  const args = [
    '--json',
    '--color',
    'never',
    '--line-number',
    '--column',
    '--context',
    String(input.contextLines ?? DEFAULT_CONTEXT_LINES),
  ];

  if (input.exact.regex !== true) {
    args.push('--fixed-strings');
  }
  if (input.exact.caseSensitive !== true) {
    args.push('--ignore-case');
  }
  if (target === 'docs') {
    args.push(
      '--glob',
      '*.md',
      '--glob',
      '*.mdx',
      '--glob',
      '*.txt',
      '--glob',
      'docs/**',
      '--glob',
      'README*',
      '--glob',
      'CHANGELOG*',
    );
  }
  for (const glob of target === 'docs' ? [] : (input.globs ?? [])) {
    args.push('--glob', glob);
  }
  for (const pattern of exactPatterns) {
    args.push('--regexp', pattern);
  }

  args.push('--', ...searchPaths);
  return args;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
