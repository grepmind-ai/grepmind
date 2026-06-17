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
const MAX_RG_GLOB_COUNT = 20;
const MAX_RG_GLOB_LENGTH = 200;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MAX_ABSOLUTE_MATCHES = 200;

export interface LocalRgSearchInput {
  workspacePath: string;
  branch: string;
  target?: SearchTarget;
  exact: SearchExactQuery;
  path?: string;
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
    validateInput(input);
    const scope = await resolveScope(input.workspacePath, input.path);
    if (!scope.exists) {
      return {
        items: [],
        stats: {
          matchCount: 0,
          fileCount: 0,
          truncated: false,
          durationMs: 0,
        },
        warning: `Local rg path does not exist: ${input.path}`,
      };
    }

    const target = input.target ?? 'code';
    return runRg({
      args: buildRgArgs(input, scope.searchPath, target),
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

function validateInput(input: LocalRgSearchInput): void {
  validateExactPattern(input.exact.pattern);
  validateContextLines(input.contextLines);
  validateGlobs(input.globs);
}

function validateExactPattern(patternInput: string): void {
  const pattern = patternInput.trim();
  if (!pattern) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      'exact.pattern must be a non-empty string',
    );
  }
  if (pattern.length > MAX_RG_PATTERN_LENGTH) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      `exact.pattern must be at most ${MAX_RG_PATTERN_LENGTH} characters`,
    );
  }
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
  searchPath: string,
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

  args.push('--', input.exact.pattern, searchPath);
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
