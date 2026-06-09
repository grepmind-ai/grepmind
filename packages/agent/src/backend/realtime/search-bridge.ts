import type {
  SearchErrorPayload,
  SearchIndexRequestPayload,
  SearchQuery,
  SearchRequestPayload,
  SearchResponsePayload,
  SearchResultItem,
  SearchTarget,
} from '../contracts/index.js';

export class AgentRealtimeSearchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    message: string,
    code = 'SEARCH_FAILED',
    options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'AgentRealtimeSearchError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function normalizeSearchIndexRequestPayload(
  data: Record<string, unknown> | undefined,
):
  | { ok: true; value: SearchIndexRequestPayload }
  | { ok: false; error: string } {
  const requestId =
    typeof data?.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    return { ok: false, error: 'requestId is required' };
  }

  const bindingId = normalizePositiveInteger(data?.bindingId);
  if (bindingId == null) {
    return { ok: false, error: 'bindingId must be a positive integer' };
  }

  const revisionId = normalizePositiveInteger(data?.revisionId);
  if (revisionId == null) {
    return { ok: false, error: 'revisionId must be a positive integer' };
  }

  const query = normalizeSearchQuery(data?.query);
  if (!query.ok) {
    return query;
  }

  return {
    ok: true,
    value: {
      requestId,
      bindingId,
      revisionId,
      query: query.value,
    },
  };
}

export function normalizeSearchRequestPayload(
  data: SearchRequestPayload,
): { ok: true; value: SearchRequestPayload } | { ok: false; error: string } {
  const requestId =
    typeof data?.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    return { ok: false, error: 'requestId is required' };
  }

  const bindingId = normalizePositiveInteger(data?.bindingId);
  if (bindingId == null) {
    return { ok: false, error: 'bindingId must be a positive integer' };
  }

  const revisionId = normalizePositiveInteger(data?.revisionId);
  if (revisionId == null) {
    return { ok: false, error: 'revisionId must be a positive integer' };
  }

  if (typeof data?.query !== 'string') {
    return { ok: false, error: 'query must be a string' };
  }

  const target = normalizeSearchTarget(data.target);
  if (data.target != null && target == null) {
    return { ok: false, error: 'target must be code or docs' };
  }

  const limit =
    data.limit == null ? undefined : normalizePositiveInteger(data.limit);
  if (data.limit != null && limit == null) {
    return { ok: false, error: 'limit must be a positive integer' };
  }

  const threshold =
    data.threshold == null ? undefined : normalizeFiniteNumber(data.threshold);
  if (data.threshold != null && threshold == null) {
    return { ok: false, error: 'threshold must be a finite number' };
  }

  if (data.rerank != null && typeof data.rerank !== 'boolean') {
    return { ok: false, error: 'rerank must be a boolean' };
  }

  const tags = normalizeTags(data.tags);
  if (data.tags != null && tags == null) {
    return { ok: false, error: 'tags must be an array of strings' };
  }

  return {
    ok: true,
    value: {
      requestId,
      bindingId,
      revisionId,
      query: data.query.trim(),
      target: target ?? undefined,
      limit: limit ?? undefined,
      threshold: threshold ?? undefined,
      rerank: data.rerank,
      tags: tags ?? undefined,
    },
  };
}

export function normalizeSearchResponsePayload(
  data: Record<string, unknown> | undefined,
): { ok: true; value: SearchResponsePayload } | { ok: false; error: string } {
  const requestId =
    typeof data?.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    return { ok: false, error: 'requestId is required' };
  }
  if (!Array.isArray(data?.items)) {
    return { ok: false, error: 'items must be an array' };
  }

  const items: SearchResultItem[] = [];
  for (const item of data.items) {
    const normalized = normalizeSearchResultItem(item);
    if (!normalized.ok) {
      return normalized;
    }
    items.push(normalized.value);
  }

  const meta = data?.meta;
  if (!meta || typeof meta !== 'object') {
    return { ok: false, error: 'meta is required' };
  }

  const bindingId = normalizePositiveInteger(
    (meta as { bindingId?: unknown }).bindingId,
  );
  const revisionId = normalizePositiveInteger(
    (meta as { revisionId?: unknown }).revisionId,
  );
  const durationMs = normalizeFiniteNumber(
    (meta as { durationMs?: unknown }).durationMs,
  );
  const totalResults = normalizeNonNegativeInteger(
    (meta as { totalResults?: unknown }).totalResults,
  );
  if (
    bindingId == null ||
    revisionId == null ||
    durationMs == null ||
    totalResults == null
  ) {
    return { ok: false, error: 'meta contains invalid search response fields' };
  }

  return {
    ok: true,
    value: {
      requestId,
      items,
      meta: {
        bindingId,
        revisionId,
        durationMs,
        totalResults,
      },
    },
  };
}

export function normalizeSearchErrorPayload(
  data: Record<string, unknown> | undefined,
): { ok: true; value: SearchErrorPayload } | { ok: false; error: string } {
  const requestId =
    typeof data?.requestId === 'string' ? data.requestId.trim() : '';
  const code = typeof data?.code === 'string' ? data.code.trim() : '';
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  const retryable =
    typeof data?.retryable === 'boolean' ? data.retryable : null;
  if (!requestId || !code || !message) {
    return { ok: false, error: 'requestId, code, and message are required' };
  }
  if (retryable == null) {
    return { ok: false, error: 'retryable is required' };
  }

  return {
    ok: true,
    value: {
      requestId,
      code,
      message,
      retryable,
      nextAction: normalizeNextAction(data?.nextAction),
      retryAfterMs: normalizeRetryAfterMs(data?.retryAfterMs),
      quota: data?.quota,
    },
  };
}

function normalizeNextAction(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function normalizeRetryAfterMs(value: unknown): number | null | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : value === null
      ? null
      : undefined;
}

function normalizeSearchQuery(
  value: unknown,
): { ok: true; value: SearchQuery } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'query is required' };
  }

  const mode = (value as { mode?: unknown }).mode;
  if (mode !== 'vector' && mode !== 'fts' && mode !== 'hybrid') {
    return { ok: false, error: 'query.mode is invalid' };
  }

  const limit = normalizePositiveInteger((value as { limit?: unknown }).limit);
  if (limit == null) {
    return { ok: false, error: 'query.limit must be a positive integer' };
  }

  const target = normalizeSearchTarget((value as { target?: unknown }).target);
  if ((value as { target?: unknown }).target != null && target == null) {
    return { ok: false, error: 'query.target must be code or docs' };
  }

  const vectorValue = (value as { vector?: unknown }).vector;
  const vector =
    vectorValue == null
      ? undefined
      : Array.isArray(vectorValue) &&
          vectorValue.every(
            (entry) => typeof entry === 'number' && Number.isFinite(entry),
          )
        ? [...vectorValue]
        : null;
  if (vectorValue != null && vector == null) {
    return {
      ok: false,
      error: 'query.vector must be an array of finite numbers',
    };
  }

  const filtersValue = (value as { filters?: unknown }).filters;
  if (!filtersValue || typeof filtersValue !== 'object') {
    return { ok: false, error: 'query.filters is required' };
  }

  const bindingId = normalizePositiveInteger(
    (filtersValue as { bindingId?: unknown }).bindingId,
  );
  const revisionId = normalizePositiveInteger(
    (filtersValue as { revisionId?: unknown }).revisionId,
  );
  const tags = normalizeTags((filtersValue as { tags?: unknown }).tags);
  if (bindingId == null || revisionId == null) {
    return {
      ok: false,
      error: 'query.filters.bindingId and revisionId must be positive integers',
    };
  }
  if ((filtersValue as { tags?: unknown }).tags != null && tags == null) {
    return {
      ok: false,
      error: 'query.filters.tags must be an array of strings',
    };
  }

  return {
    ok: true,
    value: {
      mode,
      limit,
      threshold: normalizeOptionalFiniteNumber(
        (value as { threshold?: unknown }).threshold,
      ),
      target: target ?? undefined,
      text:
        typeof (value as { text?: unknown }).text === 'string'
          ? (value as { text: string }).text
          : undefined,
      vector: vector ?? undefined,
      filters: {
        bindingId,
        revisionId,
        tags: tags ?? undefined,
      },
      fuzziness: normalizeOptionalFiniteNumber(
        (value as { fuzziness?: unknown }).fuzziness,
      ),
      phraseMatch:
        typeof (value as { phraseMatch?: unknown }).phraseMatch === 'boolean'
          ? (value as { phraseMatch: boolean }).phraseMatch
          : undefined,
      phraseSlop: normalizeOptionalFiniteNumber(
        (value as { phraseSlop?: unknown }).phraseSlop,
      ),
      vectorWeight: normalizeOptionalFiniteNumber(
        (value as { vectorWeight?: unknown }).vectorWeight,
      ),
      ftsWeight: normalizeOptionalFiniteNumber(
        (value as { ftsWeight?: unknown }).ftsWeight,
      ),
    },
  };
}

function normalizeSearchResultItem(
  value: unknown,
): { ok: true; value: SearchResultItem } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'items must contain objects' };
  }

  const target = normalizeSearchTarget((value as { target?: unknown }).target);
  const tags = normalizeTags((value as { tags?: unknown }).tags);
  if (target == null || tags == null) {
    return { ok: false, error: 'search result item is invalid' };
  }

  const symbolValue = (value as { symbol?: unknown }).symbol;
  if (!symbolValue || typeof symbolValue !== 'object') {
    return { ok: false, error: 'search result symbol is required' };
  }

  const startLine = normalizeNonNegativeInteger(
    (symbolValue as { startLine?: unknown }).startLine,
  );
  const endLine = normalizeNonNegativeInteger(
    (symbolValue as { endLine?: unknown }).endLine,
  );
  const score = normalizeFiniteNumber((value as { score?: unknown }).score);
  if (startLine == null || endLine == null || score == null) {
    return {
      ok: false,
      error: 'search result item contains invalid numeric fields',
    };
  }

  return {
    ok: true,
    value: {
      chunkId: normalizeString((value as { chunkId?: unknown }).chunkId),
      artifactRef: normalizeNullableString(
        (value as { artifactRef?: unknown }).artifactRef,
      ),
      branch: normalizeString((value as { branch?: unknown }).branch),
      target,
      path: normalizeString((value as { path?: unknown }).path),
      relativePath: normalizeString(
        (value as { relativePath?: unknown }).relativePath,
      ),
      previewText: normalizeString(
        (value as { previewText?: unknown }).previewText,
      ),
      score,
      symbol: {
        id: normalizeString((symbolValue as { id?: unknown }).id),
        name: normalizeString((symbolValue as { name?: unknown }).name),
        type: normalizeString((symbolValue as { type?: unknown }).type),
        signature: normalizeNullableString(
          (symbolValue as { signature?: unknown }).signature,
        ),
        docstring: normalizeNullableString(
          (symbolValue as { docstring?: unknown }).docstring,
        ),
        startLine,
        endLine,
        parentSymbol: normalizeNullableString(
          (symbolValue as { parentSymbol?: unknown }).parentSymbol,
        ),
      },
      tags,
    },
  };
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeSearchTarget(value: unknown): SearchTarget | null {
  return value === 'code' || value === 'docs' ? value : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = normalizeFiniteNumber(value);
  return parsed ?? undefined;
}

function normalizeTags(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = value.map((entry) =>
    typeof entry === 'string' ? entry.trim().toLowerCase() : null,
  );
  if (normalized.some((entry) => entry == null)) {
    return null;
  }

  return [
    ...new Set(normalized.filter((entry): entry is string => entry != null)),
  ];
}
