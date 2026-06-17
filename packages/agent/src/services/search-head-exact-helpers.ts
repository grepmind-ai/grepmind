import type {
  SearchResponsePayload,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { SearchHeadResult } from './search-head-service.js';
import {
  LocalRgSearchError,
  type LocalRgSearchResult,
} from './local-rg-search-service.js';

export type GuardedSearchSignal<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: unknown;
    };

export async function guardSearchSignal<T>(
  task: () => Promise<T>,
): Promise<GuardedSearchSignal<T>> {
  try {
    return {
      ok: true,
      value: await task(),
    };
  } catch (error) {
    return {
      ok: false,
      error,
    };
  }
}

export function withScope(
  response: SearchResponsePayload,
  scope: SearchHeadResult['scope'],
): SearchHeadResult {
  return {
    ...response,
    scope,
  };
}

export function createRgWarning(
  rgResult: GuardedSearchSignal<LocalRgSearchResult> | null,
  skippedWarning: string | undefined,
): string | undefined {
  if (skippedWarning) {
    return skippedWarning;
  }
  if (!rgResult) {
    return undefined;
  }
  if (rgResult.ok) {
    return rgResult.value.warning;
  }

  return createSearchWarning(rgResult.error);
}

export function createSearchWarning(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFatalLocalRgError(error: unknown): boolean {
  return (
    error instanceof LocalRgSearchError &&
    (error.code === 'RG_PATH_OUTSIDE_WORKSPACE' ||
      error.code === 'RG_WORKSPACE_NOT_FOUND' ||
      error.code === 'RG_INVALID_INPUT')
  );
}

export function chooseSearchHeadError(input: {
  semanticError: unknown;
  rgResult: GuardedSearchSignal<LocalRgSearchResult> | null;
}): unknown {
  if (
    input.rgResult &&
    !input.rgResult.ok &&
    isInvalidRegexError(input.rgResult.error)
  ) {
    return input.rgResult.error;
  }

  return input.semanticError;
}

export function isExactSearchUserFixableError(error: unknown): boolean {
  return (
    error instanceof LocalRgSearchError &&
    (error.code === 'RG_INVALID_REGEX' || error.code === 'RG_NOT_FOUND')
  );
}

export function createNoUsableExactSearchError(error: unknown): Error {
  if (error instanceof LocalRgSearchError) {
    if (error.code === 'RG_NOT_FOUND') {
      return new LocalRgSearchError(
        'RG_NOT_FOUND',
        'Local exact code_search requires ripgrep (rg) in PATH because semantic search returned no usable results.',
      );
    }

    return error;
  }

  return error instanceof Error ? error : new Error(String(error));
}

export function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error('--query is required');
  }

  return normalized;
}

export function normalizeTarget(
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

export function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit == null) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive number');
  }

  return limit;
}

export function normalizeThreshold(
  threshold: number | undefined,
): number | undefined {
  if (threshold == null) {
    return undefined;
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('--threshold must be between 0 and 1');
  }

  return threshold;
}

export function normalizeContextLines(
  contextLines: number | undefined,
  input: { defaultValue: number; maxValue: number },
): number {
  if (contextLines == null) {
    return input.defaultValue;
  }
  if (
    !Number.isInteger(contextLines) ||
    contextLines < 0 ||
    contextLines > input.maxValue
  ) {
    throw new Error(
      `--context-lines must be an integer between 0 and ${input.maxValue}`,
    );
  }

  return contextLines;
}

export function normalizeTags(
  tags: string[] | undefined,
): string[] | undefined {
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

function isInvalidRegexError(error: unknown): boolean {
  return (
    error instanceof LocalRgSearchError && error.code === 'RG_INVALID_REGEX'
  );
}
