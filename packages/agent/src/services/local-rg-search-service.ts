import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  SearchResultItem,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { SearchExactQuery } from '../runtime/rpc/protocol.js';

export const DEFAULT_RG_TIMEOUT_MS = 7_500;
const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_RG_STDERR_BYTES = 64 * 1024;
const MAX_RG_PREVIEW_CHARS = 4_000;
const MAX_RG_PATTERN_LENGTH = 500;
const MAX_RG_GLOB_COUNT = 20;
const MAX_RG_GLOB_LENGTH = 200;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MAX_ABSOLUTE_MATCHES = 200;

export type LocalRgSearchErrorCode =
  | 'RG_NOT_FOUND'
  | 'RG_INVALID_REGEX'
  | 'RG_TIMEOUT'
  | 'RG_OUTPUT_LIMIT'
  | 'RG_PROCESS_FAILED'
  | 'RG_PATH_OUTSIDE_WORKSPACE'
  | 'RG_WORKSPACE_NOT_FOUND'
  | 'RG_INVALID_INPUT';

export class LocalRgSearchError extends Error {
  readonly retryable: boolean;
  readonly stderrPreview?: string;

  constructor(
    readonly code: LocalRgSearchErrorCode,
    message: string,
    options: { retryable?: boolean; stderrPreview?: string } = {},
  ) {
    super(message);
    this.name = 'LocalRgSearchError';
    this.retryable = options.retryable ?? isRetryableLocalRgError(code);
    this.stderrPreview = options.stderrPreview;
  }
}

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

export interface LocalRgSearchResult {
  items: SearchResultItem[];
  stats: {
    matchCount: number;
    fileCount: number;
    truncated: boolean;
    durationMs: number;
  };
  warning?: string;
}

interface ResolvedScope {
  workspaceRoot: string;
  searchPath: string;
  exists: boolean;
}

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
  };
}

interface ContextLine {
  lineNumber: number;
  text: string;
}

interface ParsedUserGlob {
  raw: string;
  negated: boolean;
  matcher: RegExp;
  basenameMatcher: RegExp | null;
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

    const maxMatches = Math.min(
      Math.max(input.limit * 5, input.limit),
      MAX_ABSOLUTE_MATCHES,
    );
    const target = input.target ?? 'code';
    const args = buildRgArgs(input, scope.searchPath, target);
    return runRg({
      args,
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
      maxMatches,
    });
  }
}

function validateInput(input: LocalRgSearchInput): void {
  const pattern = input.exact.pattern.trim();
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
  if (
    input.contextLines != null &&
    (!Number.isInteger(input.contextLines) ||
      input.contextLines < 0 ||
      input.contextLines > MAX_CONTEXT_LINES)
  ) {
    throw new LocalRgSearchError(
      'RG_INVALID_INPUT',
      `contextLines must be an integer between 0 and ${MAX_CONTEXT_LINES}`,
    );
  }
  if (input.globs != null) {
    if (input.globs.length > MAX_RG_GLOB_COUNT) {
      throw new LocalRgSearchError(
        'RG_INVALID_INPUT',
        `globs must contain at most ${MAX_RG_GLOB_COUNT} entries`,
      );
    }
    for (const glob of input.globs) {
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
}

async function resolveScope(
  workspacePath: string,
  userPath: string | undefined,
): Promise<ResolvedScope> {
  const workspaceRoot = await realpath(path.resolve(workspacePath)).catch(() => {
    throw new LocalRgSearchError(
      'RG_WORKSPACE_NOT_FOUND',
      `Workspace path does not exist: ${workspacePath}`,
    );
  });
  const normalizedPath = userPath?.trim().replace(/^[/\\]+/, '');
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

function runRg(input: {
  args: string[];
  branch: string;
  regex: boolean;
  target: SearchTarget;
  timeoutMs: number;
  userGlobs?: ParsedUserGlob[];
  workspaceRoot: string;
  maxMatches: number;
}): Promise<LocalRgSearchResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('rg', input.args, {
      cwd: input.workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const beforeContextByPath = new Map<string, ContextLine[]>();
    const lastItemByPath = new Map<string, SearchResultItem>();
    const items: SearchResultItem[] = [];
    const matchedFiles = new Set<string>();
    let stderr = '';
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let stdoutLimitExceeded = false;
    let matchLimitExceeded = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, input.timeoutMs);

    const settle = (
      result:
        | { ok: true; value: LocalRgSearchResult }
        | { ok: false; error: unknown },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (result.ok) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        settle({
          ok: false,
          error: new LocalRgSearchError(
            'RG_NOT_FOUND',
            'ripgrep (rg) is not installed or not available on PATH',
          ),
        });
        return;
      }

      settle({
        ok: false,
        error: new LocalRgSearchError(
          'RG_PROCESS_FAILED',
          `Failed to start rg: ${error.message}`,
          { stderrPreview: firstDiagnosticLine(stderr) },
        ),
      });
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RG_STDOUT_BYTES) {
        stdoutLimitExceeded = true;
        terminateProcess(child);
        return;
      }

      stdoutBuffer += chunk.toString('utf8');
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        consumeRgJsonLine(line, {
          beforeContextByPath,
          branch: input.branch,
          items,
          lastItemByPath,
          matchedFiles,
          regex: input.regex,
          target: input.target,
          userGlobs: input.userGlobs,
          workspaceRoot: input.workspaceRoot,
        });
        if (items.length >= input.maxMatches) {
          matchLimitExceeded = true;
          terminateProcess(child);
          break;
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_RG_STDERR_BYTES) {
        return;
      }
      const remainingBytes = MAX_RG_STDERR_BYTES - stderrBytes;
      const piece = chunk.subarray(0, remainingBytes).toString('utf8');
      stderr += piece;
      stderrBytes += Buffer.byteLength(piece);
    });

    child.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) {
        consumeRgJsonLine(stdoutBuffer, {
          beforeContextByPath,
          branch: input.branch,
          items,
          lastItemByPath,
          matchedFiles,
          regex: input.regex,
          target: input.target,
          userGlobs: input.userGlobs,
          workspaceRoot: input.workspaceRoot,
        });
        stdoutBuffer = '';
      }

      const truncated =
        timedOut || stdoutLimitExceeded || matchLimitExceeded || signal != null;
      const warning = createRgWarning({
        matchLimitExceeded,
        stdoutLimitExceeded,
        timedOut,
        timeoutMs: input.timeoutMs,
      });

      if (
        code === 0 ||
        code === 1 ||
        matchLimitExceeded ||
        (truncated && items.length > 0)
      ) {
        settle({
          ok: true,
          value: {
            items,
            stats: {
              matchCount: items.length,
              fileCount: matchedFiles.size,
              truncated,
              durationMs: Date.now() - startedAt,
            },
            warning,
          },
        });
        return;
      }

      if (timedOut) {
        settle({
          ok: false,
          error: new LocalRgSearchError(
            'RG_TIMEOUT',
            `Local rg search timed out after ${input.timeoutMs}ms before returning usable results.`,
            { retryable: true },
          ),
        });
        return;
      }

      if (stdoutLimitExceeded) {
        settle({
          ok: false,
          error: new LocalRgSearchError(
            'RG_OUTPUT_LIMIT',
            `Local rg output exceeded ${MAX_RG_STDOUT_BYTES} bytes before returning usable results.`,
            { retryable: true },
          ),
        });
        return;
      }

      if (code === 2 && isInvalidRegexError(stderr)) {
        const stderrPreview = firstDiagnosticLine(stderr);
        settle({
          ok: false,
          error: new LocalRgSearchError(
            'RG_INVALID_REGEX',
            `Invalid rg regex: ${stderrPreview}`,
            { stderrPreview },
          ),
        });
        return;
      }

      const stderrPreview = firstDiagnosticLine(stderr);
      settle({
        ok: false,
        error: new LocalRgSearchError(
          'RG_PROCESS_FAILED',
          `rg failed with exit code ${code ?? 'unknown'}: ${stderrPreview}`,
          { stderrPreview },
        ),
      });
    });
  });
}

function consumeRgJsonLine(
  line: string,
  state: {
    beforeContextByPath: Map<string, ContextLine[]>;
    branch: string;
    items: SearchResultItem[];
    lastItemByPath: Map<string, SearchResultItem>;
    matchedFiles: Set<string>;
    regex: boolean;
    target: SearchTarget;
    userGlobs?: ParsedUserGlob[];
    workspaceRoot: string;
  },
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let event: RgJsonEvent;
  try {
    event = JSON.parse(trimmed) as RgJsonEvent;
  } catch {
    return;
  }

  if (event.type !== 'match' && event.type !== 'context') {
    return;
  }

  const eventPath = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  const text = event.data?.lines?.text;
  if (!eventPath || typeof lineNumber !== 'number' || text == null) {
    return;
  }

  const absolutePath = path.isAbsolute(eventPath)
    ? path.resolve(eventPath)
    : path.resolve(state.workspaceRoot, eventPath);
  if (!isPathWithin(state.workspaceRoot, absolutePath)) {
    return;
  }

  const relativePath = toPosixPath(
    path.relative(state.workspaceRoot, absolutePath),
  );
  if (state.target === 'docs' && !isDocsPath(relativePath)) {
    return;
  }
  if (!matchesUserGlobs(relativePath, state.userGlobs)) {
    return;
  }

  if (event.type === 'context') {
    consumeContextLine({
      beforeContextByPath: state.beforeContextByPath,
      key: relativePath,
      lastItemByPath: state.lastItemByPath,
      lineNumber,
      text,
    });
    return;
  }

  const column = event.data?.submatches?.[0]?.start ?? 0;
  const beforeContext = state.beforeContextByPath.get(relativePath) ?? [];
  state.beforeContextByPath.delete(relativePath);
  const previewLines = [
    ...beforeContext.map((entry) =>
      formatPreviewLine(entry.lineNumber, entry.text),
    ),
    formatPreviewLine(lineNumber, text),
  ];
  const item: SearchResultItem = {
    chunkId: `rg:${relativePath}:${lineNumber}:${column + 1}`,
    artifactRef: null,
    branch: state.branch,
    target: state.target,
    path: absolutePath,
    relativePath,
    previewText: truncatePreview(previewLines.join('\n')),
    score: createRgScore(state.regex),
    symbol: {
      id: `rg:${relativePath}:${lineNumber}:${column + 1}`,
      name: '',
      type: 'match',
      signature: null,
      docstring: null,
      startLine: lineNumber,
      endLine: lineNumber,
      parentSymbol: null,
    },
    tags: [],
  };

  state.items.push(item);
  state.matchedFiles.add(relativePath);
  state.lastItemByPath.set(relativePath, item);
}

function consumeContextLine(input: {
  beforeContextByPath: Map<string, ContextLine[]>;
  key: string;
  lastItemByPath: Map<string, SearchResultItem>;
  lineNumber: number;
  text: string;
}): void {
  const lastItem = input.lastItemByPath.get(input.key);
  if (lastItem && input.lineNumber > lastItem.symbol.startLine) {
    lastItem.previewText = truncatePreview(
      `${lastItem.previewText}\n${formatPreviewLine(input.lineNumber, input.text)}`,
    );
    return;
  }

  const existing = input.beforeContextByPath.get(input.key) ?? [];
  existing.push({
    lineNumber: input.lineNumber,
    text: input.text,
  });
  input.beforeContextByPath.set(input.key, existing.slice(-MAX_CONTEXT_LINES));
}

function createRgScore(regex: boolean): number {
  return regex ? 0.88 : 0.92;
}

function createRgWarning(input: {
  matchLimitExceeded: boolean;
  stdoutLimitExceeded: boolean;
  timedOut: boolean;
  timeoutMs: number;
}): string | undefined {
  if (input.timedOut) {
    return `Local rg search timed out after ${input.timeoutMs}ms; returning partial results.`;
  }
  if (input.stdoutLimitExceeded) {
    return `Local rg output exceeded ${MAX_RG_STDOUT_BYTES} bytes; returning partial results.`;
  }
  if (input.matchLimitExceeded) {
    return 'Local rg match limit reached; returning partial results.';
  }

  return undefined;
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (child.killed) {
    return;
  }

  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
    }
  }, 500).unref();
}

function isRetryableLocalRgError(code: LocalRgSearchErrorCode): boolean {
  return (
    code === 'RG_TIMEOUT' ||
    code === 'RG_OUTPUT_LIMIT' ||
    code === 'RG_PROCESS_FAILED'
  );
}

function parseUserGlobs(globs: string[]): ParsedUserGlob[] {
  return globs.map((rawGlob) => {
    const raw = rawGlob.trim();
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    return {
      raw,
      negated,
      matcher: globToRegExp(pattern),
      basenameMatcher: pattern.includes('/')
        ? null
        : globToRegExp(`**/${pattern}`),
    };
  });
}

function matchesUserGlobs(
  relativePath: string,
  globs: ParsedUserGlob[] | undefined,
): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }

  let hasPositive = false;
  let positiveMatch = false;
  for (const glob of globs) {
    const matches =
      glob.matcher.test(relativePath) ||
      (glob.basenameMatcher?.test(relativePath) ?? false);
    if (glob.negated) {
      if (matches) {
        return false;
      }
      continue;
    }

    hasPositive = true;
    positiveMatch ||= matches;
  }

  return !hasPositive || positiveMatch;
}

function isDocsPath(relativePath: string): boolean {
  const basename = relativePath.split('/').pop() ?? relativePath;
  return (
    relativePath.startsWith('docs/') ||
    relativePath.endsWith('.md') ||
    relativePath.endsWith('.mdx') ||
    relativePath.endsWith('.txt') ||
    basename.startsWith('README') ||
    basename.startsWith('CHANGELOG')
  );
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern
    .trim()
    .replace(/^[/\\]+/, '')
    .replaceAll('\\', '/')
    .split(path.sep)
    .join('/');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '*') {
      if (next === '*') {
        const afterGlobstar = normalized[index + 2];
        if (afterGlobstar === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(char);
  }

  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function formatPreviewLine(lineNumber: number, text: string): string {
  return `${lineNumber}: ${text.replaceAll(/\r?\n$/g, '')}`;
}

function truncatePreview(value: string): string {
  return value.length > MAX_RG_PREVIEW_CHARS
    ? `${value.slice(0, MAX_RG_PREVIEW_CHARS - 3)}...`
    : value;
}

function isInvalidRegexError(stderr: string): boolean {
  return /regex parse error|error parsing regex|invalid regex|PCRE2: error/i.test(
    stderr,
  );
}

function firstDiagnosticLine(stderr: string): string {
  const diagnostic = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return diagnostic ?? 'no diagnostic output';
}

function isNotFoundError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
