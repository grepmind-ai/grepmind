import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  SearchResultItem,
  SearchTarget,
} from '../backend/contracts/index.js';
import {
  LocalRgSearchError,
  type LocalRgSearchResult,
} from './local-rg-search-types.js';
import { matchesUserGlobs, type ParsedUserGlob } from './local-rg-globs.js';

const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_RG_STDERR_BYTES = 64 * 1024;
const MAX_RG_PREVIEW_CHARS = 4_000;
const MAX_CONTEXT_LINES = 10;

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

export function runRg(input: {
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
    const state = createRunState(input);
    const settle = createSettler(state, resolve, reject);

    state.child.on('error', (error: NodeJS.ErrnoException) => {
      settle(createStartError(error, state.stderr));
    });
    state.child.stdout.on('data', (chunk: Buffer) => {
      consumeStdoutChunk(chunk, input, state);
    });
    state.child.stderr.on('data', (chunk: Buffer) => {
      state.stderr = appendLimitedStderr(state.stderr, chunk);
    });
    state.child.on('close', (code, signal) => {
      settle(createCloseResult(code, signal, input, state));
    });
  });
}

function createRunState(input: {
  args: string[];
  timeoutMs: number;
  workspaceRoot: string;
}) {
  const child = spawn('rg', input.args, {
    cwd: input.workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = {
    beforeContextByPath: new Map<string, ContextLine[]>(),
    child,
    items: [] as SearchResultItem[],
    lastItemByPath: new Map<string, SearchResultItem>(),
    matchedFiles: new Set<string>(),
    matchLimitExceeded: false,
    settled: false,
    startedAt: Date.now(),
    stderr: '',
    stdoutBuffer: '',
    stdoutBytes: 0,
    stdoutLimitExceeded: false,
    timedOut: false,
    timeout: setTimeout(() => {
      state.timedOut = true;
      terminateProcess(child);
    }, input.timeoutMs),
  };

  return state;
}

function createSettler(
  state: ReturnType<typeof createRunState>,
  resolve: (value: LocalRgSearchResult) => void,
  reject: (reason: unknown) => void,
) {
  return (
    result:
      | { ok: true; value: LocalRgSearchResult }
      | { ok: false; error: unknown },
  ): void => {
    if (state.settled) {
      return;
    }
    state.settled = true;
    clearTimeout(state.timeout);
    if (result.ok) {
      resolve(result.value);
    } else {
      reject(result.error);
    }
  };
}

function createStartError(
  error: NodeJS.ErrnoException,
  stderr: string,
): { ok: false; error: LocalRgSearchError } {
  if (error.code === 'ENOENT') {
    return {
      ok: false,
      error: new LocalRgSearchError(
        'RG_NOT_FOUND',
        'ripgrep (rg) is not installed or not available on PATH',
      ),
    };
  }

  return {
    ok: false,
    error: new LocalRgSearchError(
      'RG_PROCESS_FAILED',
      `Failed to start rg: ${error.message}`,
      { stderrPreview: firstDiagnosticLine(stderr) },
    ),
  };
}

function consumeStdoutChunk(
  chunk: Buffer,
  input: Parameters<typeof runRg>[0],
  state: ReturnType<typeof createRunState>,
): void {
  state.stdoutBytes += chunk.length;
  if (state.stdoutBytes > MAX_RG_STDOUT_BYTES) {
    state.stdoutLimitExceeded = true;
    terminateProcess(state.child);
    return;
  }

  state.stdoutBuffer += chunk.toString('utf8');
  let newlineIndex = state.stdoutBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = state.stdoutBuffer.slice(0, newlineIndex);
    state.stdoutBuffer = state.stdoutBuffer.slice(newlineIndex + 1);
    consumeRgJsonLine(line, input, state);
    if (state.items.length >= input.maxMatches) {
      state.matchLimitExceeded = true;
      terminateProcess(state.child);
      break;
    }
    newlineIndex = state.stdoutBuffer.indexOf('\n');
  }
}

function appendLimitedStderr(current: string, chunk: Buffer): string {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= MAX_RG_STDERR_BYTES) {
    return current;
  }

  const remainingBytes = MAX_RG_STDERR_BYTES - currentBytes;
  return current + chunk.subarray(0, remainingBytes).toString('utf8');
}

function createCloseResult(
  code: number | null,
  signal: NodeJS.Signals | null,
  input: Parameters<typeof runRg>[0],
  state: ReturnType<typeof createRunState>,
):
  | { ok: true; value: LocalRgSearchResult }
  | { ok: false; error: LocalRgSearchError } {
  if (state.stdoutBuffer.trim()) {
    consumeRgJsonLine(state.stdoutBuffer, input, state);
    state.stdoutBuffer = '';
  }

  const truncated =
    state.timedOut ||
    state.stdoutLimitExceeded ||
    state.matchLimitExceeded ||
    signal != null;
  const warning = createRgWarning({
    matchLimitExceeded: state.matchLimitExceeded,
    stdoutLimitExceeded: state.stdoutLimitExceeded,
    timedOut: state.timedOut,
    timeoutMs: input.timeoutMs,
  });

  if (
    code === 0 ||
    code === 1 ||
    state.matchLimitExceeded ||
    (truncated && state.items.length > 0)
  ) {
    return {
      ok: true,
      value: {
        items: state.items,
        stats: {
          matchCount: state.items.length,
          fileCount: state.matchedFiles.size,
          truncated,
          durationMs: Date.now() - state.startedAt,
        },
        warning,
      },
    };
  }

  return createCloseError(code, input.timeoutMs, state);
}

function createCloseError(
  code: number | null,
  timeoutMs: number,
  state: ReturnType<typeof createRunState>,
): { ok: false; error: LocalRgSearchError } {
  if (state.timedOut) {
    return {
      ok: false,
      error: new LocalRgSearchError(
        'RG_TIMEOUT',
        `Local rg search timed out after ${timeoutMs}ms before returning usable results.`,
        { retryable: true },
      ),
    };
  }
  if (state.stdoutLimitExceeded) {
    return {
      ok: false,
      error: new LocalRgSearchError(
        'RG_OUTPUT_LIMIT',
        `Local rg output exceeded ${MAX_RG_STDOUT_BYTES} bytes before returning usable results.`,
        { retryable: true },
      ),
    };
  }
  if (code === 2 && isInvalidRegexError(state.stderr)) {
    const stderrPreview = firstDiagnosticLine(state.stderr);
    return {
      ok: false,
      error: new LocalRgSearchError(
        'RG_INVALID_REGEX',
        `Invalid rg regex: ${stderrPreview}`,
        { stderrPreview },
      ),
    };
  }

  const stderrPreview = firstDiagnosticLine(state.stderr);
  return {
    ok: false,
    error: new LocalRgSearchError(
      'RG_PROCESS_FAILED',
      `rg failed with exit code ${code ?? 'unknown'}: ${stderrPreview}`,
      { stderrPreview },
    ),
  };
}

function consumeRgJsonLine(
  line: string,
  input: Parameters<typeof runRg>[0],
  state: ReturnType<typeof createRunState>,
): void {
  const event = parseRgJsonLine(line);
  if (!event) {
    return;
  }

  const normalized = normalizeRgEvent(event, input.workspaceRoot, input.target);
  if (
    !normalized ||
    !matchesUserGlobs(normalized.relativePath, input.userGlobs)
  ) {
    return;
  }

  if (event.type === 'context') {
    consumeContextLine({
      beforeContextByPath: state.beforeContextByPath,
      key: normalized.relativePath,
      lastItemByPath: state.lastItemByPath,
      lineNumber: normalized.lineNumber,
      text: normalized.text,
    });
    return;
  }

  const item = createRgItem({
    ...normalized,
    beforeContext: state.beforeContextByPath.get(normalized.relativePath) ?? [],
    branch: input.branch,
    column: event.data?.submatches?.[0]?.start ?? 0,
    regex: input.regex,
  });
  state.beforeContextByPath.delete(normalized.relativePath);
  state.items.push(item);
  state.matchedFiles.add(normalized.relativePath);
  state.lastItemByPath.set(normalized.relativePath, item);
}

function parseRgJsonLine(line: string): RgJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const event = JSON.parse(trimmed) as RgJsonEvent;
    return event.type === 'match' || event.type === 'context' ? event : null;
  } catch {
    return null;
  }
}

function normalizeRgEvent(
  event: RgJsonEvent,
  workspaceRoot: string,
  target: SearchTarget,
): {
  absolutePath: string;
  lineNumber: number;
  relativePath: string;
  target: SearchTarget;
  text: string;
} | null {
  const eventPath = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  const text = event.data?.lines?.text;
  if (!eventPath || typeof lineNumber !== 'number' || text == null) {
    return null;
  }

  const absolutePath = path.isAbsolute(eventPath)
    ? path.resolve(eventPath)
    : path.resolve(workspaceRoot, eventPath);
  if (!isPathWithin(workspaceRoot, absolutePath)) {
    return null;
  }

  const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));
  if (target === 'docs' && !isDocsPath(relativePath)) {
    return null;
  }

  return {
    absolutePath,
    lineNumber,
    relativePath,
    target,
    text,
  };
}

function createRgItem(input: {
  absolutePath: string;
  beforeContext: ContextLine[];
  branch: string;
  column: number;
  lineNumber: number;
  regex: boolean;
  relativePath: string;
  target: SearchTarget;
  text: string;
}): SearchResultItem {
  const locationId = `rg:${input.relativePath}:${input.lineNumber}:${
    input.column + 1
  }`;
  const previewLines = [
    ...input.beforeContext.map((entry) =>
      formatPreviewLine(entry.lineNumber, entry.text),
    ),
    formatPreviewLine(input.lineNumber, input.text),
  ];

  return {
    chunkId: locationId,
    artifactRef: null,
    branch: input.branch,
    target: input.target,
    path: input.absolutePath,
    relativePath: input.relativePath,
    previewText: truncatePreview(previewLines.join('\n')),
    score: createRgScore(input.regex),
    symbol: {
      id: locationId,
      name: '',
      type: 'match',
      signature: null,
      docstring: null,
      startLine: input.lineNumber,
      endLine: input.lineNumber,
      parentSymbol: null,
    },
    tags: [],
  };
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

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
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
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'no diagnostic output'
  );
}
