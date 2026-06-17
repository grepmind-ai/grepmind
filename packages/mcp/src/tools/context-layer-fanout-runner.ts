import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { runCodexSubagent } from './codex-subagent-runner.js';
import {
  buildContextLayerFileSummaryPrompt,
  type ContextLayerSourceFileContext,
  type ContextLayerFileSummaryPromptInput,
} from './context-layer-file-summary-prompt.js';
import {
  normalizeFileSummaryMarkdown,
  summarizeFileSummaryForLimit,
} from './context-layer-file-summary-output.js';
import { ContextLayerError } from './context-layer-errors.js';
import type { ContextLayerThinking } from './context-layer-model-config.js';
import {
  incrementContextLayerCounter,
  type ContextLayerCounter,
} from './context-layer-observability.js';
import type { ContextLayerFocus } from './context-layer-types.js';
import type { SearchResult } from './search-client.js';

export const DEFAULT_CONTEXT_LAYER_FANOUT_CONCURRENCY = 20;
export const MAX_CONTEXT_LAYER_FANOUT_CONCURRENCY = 20;
export const DEFAULT_CONTEXT_LAYER_FILE_TIMEOUT_MS = 90_000;
export const MAX_CONTEXT_LAYER_FILE_TIMEOUT_MS = 300_000;
export const DEFAULT_CONTEXT_LAYER_FILE_MAX_OUTPUT_BYTES = 40_000;
export const MIN_CONTEXT_LAYER_FILE_MAX_OUTPUT_BYTES = 4_000;
export const DEFAULT_CONTEXT_LAYER_SOURCE_FILE_MIN_SCORE = 0.5;
export const DEFAULT_CONTEXT_LAYER_SOURCE_FILE_MAX_BYTES = 200_000;
export const MIN_CONTEXT_LAYER_SOURCE_FILE_MAX_BYTES = 8_000;

export interface ContextLayerFanoutTarget {
  path: string;
  score: number;
  primaryResult: SearchResult;
  relatedResults: SearchResult[];
}

export interface ContextLayerFileSummarySuccess {
  path: string;
  score: number;
  summaryMarkdown: string;
  runtimeDurationMs: number;
  truncated: boolean;
  timeout: false;
}

export interface ContextLayerFileSummaryFailure {
  path: string;
  score: number;
  error: string;
  runtimeDurationMs?: number;
  truncated: false;
  timeout: boolean;
}

export type ContextLayerFileSummaryResult =
  | ContextLayerFileSummarySuccess
  | ContextLayerFileSummaryFailure;

export async function runContextLayerFileSummaryFanout(input: {
  requestId: string;
  workspacePath: string;
  query: string;
  originalQuery?: string;
  focus: ContextLayerFocus;
  targets: ContextLayerFanoutTarget[];
  modelName: string;
  modelThinking: ContextLayerThinking;
  concurrency: number;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{
  summaries: ContextLayerFileSummaryResult[];
  runtimeDurationMs: number;
}> {
  const startedAt = Date.now();
  incrementContextLayerCounter('context_layer_fanout_started', {
    requestId: input.requestId,
    fileCount: input.targets.length,
    concurrency: input.concurrency,
    timeoutMs: input.timeoutMs,
  });

  const summaries = await runWithConcurrency(
    input.targets,
    input.concurrency,
    async (target) => runOneFileSummary(input, target),
  );
  const runtimeDurationMs = Date.now() - startedAt;

  incrementContextLayerCounter('context_layer_fanout_completed', {
    requestId: input.requestId,
    fileCount: input.targets.length,
    completedCount: summaries.filter((summary) => 'summaryMarkdown' in summary)
      .length,
    failedCount: summaries.filter((summary) => !('summaryMarkdown' in summary))
      .length,
    durationMs: runtimeDurationMs,
  });

  return { summaries, runtimeDurationMs };
}

export function buildFanoutTargets(input: {
  results: SearchResult[];
  maxFiles: number;
}): ContextLayerFanoutTarget[] {
  const grouped = new Map<string, SearchResult[]>();
  for (const result of input.results) {
    const existing = grouped.get(result.symbol.relativePath) ?? [];
    existing.push(result);
    grouped.set(result.symbol.relativePath, existing);
  }

  return [...grouped.entries()]
    .map(([path, results]) => {
      const sorted = [...results].sort((a, b) => b.score - a.score);
      const primaryResult = sorted[0];
      if (primaryResult == null) {
        return null;
      }
      return {
        path,
        score: primaryResult.score,
        primaryResult,
        relatedResults: sorted.slice(1),
      };
    })
    .filter((target): target is ContextLayerFanoutTarget => target != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxFiles);
}

export function resolveContextLayerFanoutConcurrency(): number {
  return resolveIntegerEnv({
    name: 'GREPMIND_CONTEXT_LAYER_FANOUT_CONCURRENCY',
    defaultValue: DEFAULT_CONTEXT_LAYER_FANOUT_CONCURRENCY,
    min: 1,
    max: MAX_CONTEXT_LAYER_FANOUT_CONCURRENCY,
  });
}

export function resolveContextLayerFileTimeoutMs(): number {
  return resolveIntegerEnv({
    name: 'GREPMIND_CONTEXT_LAYER_FILE_TIMEOUT_MS',
    defaultValue: DEFAULT_CONTEXT_LAYER_FILE_TIMEOUT_MS,
    min: 1,
    max: MAX_CONTEXT_LAYER_FILE_TIMEOUT_MS,
  });
}

export function resolveContextLayerFileMaxOutputBytes(): number {
  return resolveIntegerEnv({
    name: 'GREPMIND_CONTEXT_LAYER_FILE_MAX_OUTPUT_BYTES',
    defaultValue: DEFAULT_CONTEXT_LAYER_FILE_MAX_OUTPUT_BYTES,
    min: MIN_CONTEXT_LAYER_FILE_MAX_OUTPUT_BYTES,
  });
}

export function resolveContextLayerSourceFileMaxBytes(): number {
  return resolveIntegerEnv({
    name: 'GREPMIND_CONTEXT_LAYER_SOURCE_FILE_MAX_BYTES',
    defaultValue: DEFAULT_CONTEXT_LAYER_SOURCE_FILE_MAX_BYTES,
    min: MIN_CONTEXT_LAYER_SOURCE_FILE_MAX_BYTES,
  });
}

export function resolveContextLayerSourceFileMinScore(): number {
  const raw = process.env.GREPMIND_CONTEXT_LAYER_SOURCE_FILE_MIN_SCORE?.trim();
  if (!raw) {
    return DEFAULT_CONTEXT_LAYER_SOURCE_FILE_MIN_SCORE;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      'GREPMIND_CONTEXT_LAYER_SOURCE_FILE_MIN_SCORE must be a number between 0 and 1.',
    );
  }
  return value;
}

async function runOneFileSummary(
  input: Omit<
    Parameters<typeof runContextLayerFileSummaryFanout>[0],
    'targets' | 'concurrency'
  >,
  target: ContextLayerFanoutTarget,
): Promise<ContextLayerFileSummaryResult> {
  try {
    incrementContextLayerCounter('context_layer_file_summary_started', {
      requestId: input.requestId,
      path: target.path,
    });

    const promptInput: ContextLayerFileSummaryPromptInput = {
      workspacePath: input.workspacePath,
      query: input.query,
      originalQuery: input.originalQuery,
      focus: input.focus,
      result: target.primaryResult,
      relatedResults: target.relatedResults,
      sourceFile: await readSourceFileForTarget(input.workspacePath, target),
    };
    const result = await runCodexSubagent({
      workspacePath: input.workspacePath,
      prompt: buildContextLayerFileSummaryPrompt(promptInput),
      modelName: input.modelName,
      modelThinking: input.modelThinking,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      normalizeOutput: normalizeFileSummaryMarkdown,
      truncateOutput: summarizeFileSummaryForLimit,
    });

    incrementContextLayerCounter('context_layer_file_summary_completed', {
      requestId: input.requestId,
      path: target.path,
      durationMs: result.runtimeDurationMs,
      truncated: result.truncated,
    });

    return {
      path: target.path,
      score: target.score,
      summaryMarkdown: result.contextPackMarkdown,
      runtimeDurationMs: result.runtimeDurationMs,
      truncated: result.truncated,
      timeout: false,
    };
  } catch (error) {
    const normalized = normalizeFileSummaryError(error);
    const counter: ContextLayerCounter =
      normalized.timeout === true
        ? 'context_layer_file_summary_timeout'
        : 'context_layer_file_summary_failed';
    incrementContextLayerCounter(counter, {
      requestId: input.requestId,
      path: target.path,
      errorCode: normalized.code,
      durationMs: normalized.runtimeDurationMs,
    });

    return {
      path: target.path,
      score: target.score,
      error: normalized.message,
      runtimeDurationMs: normalized.runtimeDurationMs,
      truncated: false,
      timeout: normalized.timeout,
    };
  }
}

async function readSourceFileForTarget(
  workspacePath: string,
  target: ContextLayerFanoutTarget,
): Promise<ContextLayerSourceFileContext | undefined> {
  if (target.score < resolveContextLayerSourceFileMinScore()) {
    return undefined;
  }

  try {
    const workspaceRoot = await realpath(path.resolve(workspacePath));
    const candidatePath = path.resolve(workspaceRoot, target.path);
    const realCandidatePath = await realpath(candidatePath);
    if (!isInsideWorkspace(workspaceRoot, realCandidatePath)) {
      return undefined;
    }

    const maxBytes = resolveContextLayerSourceFileMaxBytes();
    const buffer = await readFile(realCandidatePath);
    if (isProbablyBinary(buffer)) {
      return undefined;
    }

    const truncated = buffer.byteLength > maxBytes;
    const contentBuffer = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return {
      path: target.path,
      content: contentBuffer.toString('utf8'),
      truncated,
      byteLength: buffer.byteLength,
    };
  } catch {
    return undefined;
  }
}

function isInsideWorkspace(workspaceRoot: string, filePath: string): boolean {
  const relative = path.relative(workspaceRoot, filePath);
  return (
    Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 4096));
  return sample.includes(0);
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item == null) {
        continue;
      }
      results[index] = await worker(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runWorker(),
    ),
  );

  return results;
}

function normalizeFileSummaryError(error: unknown): ContextLayerError {
  if (error instanceof ContextLayerError) {
    return error;
  }

  return new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    error instanceof Error ? error.message : String(error),
  );
}

function resolveIntegerEnv(input: {
  name: string;
  defaultValue: number;
  min: number;
  max?: number;
}): number {
  const raw = process.env[input.name]?.trim();
  if (!raw) {
    return input.defaultValue;
  }

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < input.min ||
    (input.max != null && value > input.max)
  ) {
    const maxText =
      input.max == null ? '' : ` and no greater than ${input.max}`;
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `${input.name} must be an integer of at least ${input.min}${maxText}.`,
    );
  }

  return value;
}
