import path from 'node:path';
import {
  AgentRuntimeClientError,
  isRuntimeUnavailableError,
  type AgentRuntimeClient,
  type SearchExactQuery,
  type SearchHeadRpcResult,
  type SearchResultItem,
} from '@grepmind/agent-rpc';
import {
  getMcpWorkspaceContext,
  getReadyAgentRuntimeClient,
} from '../runtime-context.js';

export interface SearchResult {
  symbol: {
    id: string;
    name: string;
    type: string;
    path: string;
    relativePath: string;
    signature: string | null;
    docstring: string | null;
    startLine: number;
    endLine: number;
    parentSymbol: string | null;
  };
  tags: string[];
  score: number;
  content: string;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: RuntimeSearchMeta;
}

export interface RuntimeSearchMeta {
  semanticResults?: number;
  rgResults?: number;
  rgTruncated?: boolean;
  rgSource?: 'working_tree';
  rgWarning?: string;
  semanticWarning?: string;
  totalResults?: number;
  durationMs?: number;
}

export interface ResponseMeta {
  tokens_approx: number;
  truncated?: boolean;
  returned_results?: number;
  semantic_results?: number;
  rg_results?: number;
  rg_truncated?: boolean;
  rg_source?: 'working_tree';
  rg_warning?: string;
  semantic_warning?: string;
  [key: string]: unknown;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_SEARCH_LIMIT = 10;
const FILTER_OVERFETCH_MULTIPLIER = 5;
const MIN_FILTER_OVERFETCH_LIMIT = 50;
const MAX_FILTER_OVERFETCH_LIMIT = 200;

let searchHeadExactCapabilityPromise: Promise<boolean> | null = null;

export async function searchCode(params: {
  query: string;
  target?: 'code' | 'docs';
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  path?: string;
  tags?: string[];
  exact?: SearchExactQuery;
  globs?: string[];
  contextLines?: number;
}): Promise<SearchResponse> {
  const workspaceContext = getMcpWorkspaceContext();

  try {
    const client = getReadyAgentRuntimeClient();
    if (params.exact != null) {
      await requireSearchHeadExactCapability(client);
    }

    const requestedLimit = params.limit ?? DEFAULT_SEARCH_LIMIT;
    const searchLimit = shouldOverfetch(params)
      ? Math.min(
          Math.max(
            requestedLimit * FILTER_OVERFETCH_MULTIPLIER,
            MIN_FILTER_OVERFETCH_LIMIT,
          ),
          MAX_FILTER_OVERFETCH_LIMIT,
        )
      : requestedLimit;
    const response = await client.searchHead({
      bindingId: workspaceContext.bindingId,
      query: params.query,
      target: params.target ?? 'code',
      limit: searchLimit,
      threshold: params.threshold,
      rerank: params.rerank ?? false,
      tags: normalizeTags(params.tags),
      exact: params.exact,
      path: params.path,
      globs: params.globs,
      contextLines: params.contextLines,
    });

    return toSearchResponse(response, {
      path: params.path,
      tags: params.tags,
      limit: requestedLimit,
    });
  } catch (error) {
    throw normalizeAgentSearchError(error, workspaceContext);
  }
}

async function requireSearchHeadExactCapability(
  client: AgentRuntimeClient,
): Promise<void> {
  if (!searchHeadExactCapabilityPromise) {
    searchHeadExactCapabilityPromise = client
      .ping()
      .then((result) => {
        const supported = result.capabilities?.searchHeadExact === true;
        if (!supported) {
          searchHeadExactCapabilityPromise = null;
        }

        return supported;
      })
      .catch((error) => {
        searchHeadExactCapabilityPromise = null;
        throw error;
      });
  }

  const supported = await searchHeadExactCapabilityPromise;
  if (!supported) {
    throw new Error(
      'This Grepmind agent runtime does not support exact code_search. Restart or upgrade the Grepmind agent runtime, then retry.',
    );
  }
}

function toSearchResponse(
  response: SearchHeadRpcResult,
  filters: {
    path?: string;
    tags?: string[];
    limit: number;
  },
): SearchResponse {
  return {
    results: response.items
      .filter((item) => matchesPathFilter(item, filters.path))
      .filter((item) => matchesTagsFilter(item, filters.tags))
      .slice(0, filters.limit)
      .map(toSearchResult),
    meta: {
      semanticResults: response.meta.semanticResults,
      rgResults: response.meta.rgResults,
      rgTruncated: response.meta.rgTruncated,
      rgSource: response.meta.rgSource,
      rgWarning: response.meta.rgWarning,
      semanticWarning: response.meta.semanticWarning,
      totalResults: response.meta.totalResults,
      durationMs: response.meta.durationMs,
    },
  };
}

function shouldOverfetch(params: {
  exact?: SearchExactQuery;
  path?: string;
  tags?: string[];
}): boolean {
  return (
    params.exact != null ||
    Boolean(params.path?.trim()) ||
    normalizeTags(params.tags).length > 0
  );
}

function toSearchResult(item: SearchResultItem): SearchResult {
  return {
    symbol: {
      id: item.symbol.id,
      name: item.symbol.name,
      type: item.symbol.type,
      path: item.path,
      relativePath: item.relativePath,
      signature: item.symbol.signature,
      docstring: item.symbol.docstring,
      startLine: item.symbol.startLine,
      endLine: item.symbol.endLine,
      parentSymbol: item.symbol.parentSymbol,
    },
    tags: item.tags,
    score: item.score,
    content: item.previewText,
  };
}

function matchesPathFilter(
  item: SearchResultItem,
  pathFilter: string | undefined,
): boolean {
  const normalized = pathFilter?.trim().replace(/^\/+/, '');
  if (!normalized) {
    return true;
  }

  return (
    item.relativePath === normalized ||
    item.relativePath.startsWith(`${normalized}/`)
  );
}

function matchesTagsFilter(
  item: SearchResultItem,
  tagsFilter: string[] | undefined,
): boolean {
  const normalized = normalizeTags(tagsFilter);
  if (normalized.length === 0) {
    return true;
  }

  const itemTags = new Set(item.tags.map((tag) => tag.toLowerCase()));
  return normalized.every((tag) => itemTags.has(tag));
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ];
}

function normalizeAgentSearchError(
  error: unknown,
  workspaceContext: {
    workspacePath: string;
    bindingId: number;
    dataDir: string;
  },
): Error {
  const resolvedWorkspacePath = path.resolve(workspaceContext.workspacePath);

  if (isRuntimeUnavailableError(error)) {
    return new Error(
      `Grepmind agent runtime stopped after MCP startup for ${workspaceContext.dataDir}. Restart this MCP server to prepare the bundled runtime again.`,
    );
  }

  if (error instanceof AgentRuntimeClientError && error.code === 'NOT_FOUND') {
    return new Error(
      `Grepmind MCP prepared binding #${workspaceContext.bindingId} for ${resolvedWorkspacePath}, but the runtime no longer has that local project. Restart this MCP server to re-run workspace registration. Original error: ${error.message}`,
    );
  }

  if (error instanceof AgentRuntimeClientError) {
    const stableError = normalizeStableAgentRuntimeSearchError(
      error,
      workspaceContext,
      resolvedWorkspacePath,
    );
    if (stableError) {
      return stableError;
    }
  }

  if (
    !(error instanceof AgentRuntimeClientError) &&
    isSearchIndexNotReadyError(error)
  ) {
    return new Error(
      `Search index is not ready yet for workspace ${resolvedWorkspacePath} (binding #${workspaceContext.bindingId}). Wait for Grepmind background sync to finish, then retry. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function normalizeStableAgentRuntimeSearchError(
  error: AgentRuntimeClientError,
  workspaceContext: {
    workspacePath: string;
    bindingId: number;
    dataDir: string;
  },
  resolvedWorkspacePath: string,
): Error | null {
  switch (error.code) {
    case 'REVISION_INCOMPLETE':
      return new Error(
        `Search index is not ready yet for workspace ${resolvedWorkspacePath} (binding #${workspaceContext.bindingId}). Wait for Grepmind background sync to finish, then retry.`,
      );
    case 'SEARCH_HEAD_QUEUED':
      return new Error(
        `Local HEAD is queued for Grepmind indexing in workspace ${resolvedWorkspacePath} (binding #${workspaceContext.bindingId}). Retry shortly.`,
      );
    case 'SEARCH_HEAD_CHANGED':
      return new Error(
        `Local HEAD changed while Grepmind was preparing search in workspace ${resolvedWorkspacePath} (binding #${workspaceContext.bindingId}). Retry the search.`,
      );
    case 'PLAN_REQUIRED':
      return new Error(
        'Grepmind search requires an active account plan. Open the Grepmind app, select this account, choose a plan, then retry the MCP search.',
      );
    case 'PLAN_INACTIVE':
      return new Error(
        'The selected Grepmind account plan is not active. Renew the plan or contact support, then retry the MCP search.',
      );
    case 'QUOTA_EXCEEDED':
      return new Error(formatQuotaExceededMessage(error));
    case 'AGENT_ACCOUNT_SESSION_REQUIRED':
    case 'AGENT_ACCOUNT_SESSION_EXPIRED':
    case 'AGENT_ACCOUNT_SESSION_REVOKED':
    case 'AGENT_UPGRADE_REQUIRED':
      return new Error(
        'Grepmind agent account selection is required. Re-run agent login/account selection for this workspace, then restart the MCP server.',
      );
    case 'RUNTIME_BACKPRESSURE':
      return new Error(formatBackpressureMessage(error));
    case 'RUNTIME_PROVIDER_CONFIG_DEGRADED':
      return new Error(
        'Grepmind runtime provider configuration needs support before search can continue.',
      );
    case 'PROJECT_NOT_FOUND':
      return new Error(
        `Grepmind MCP prepared binding #${workspaceContext.bindingId} for ${resolvedWorkspacePath}, but the backend no longer exposes that project. Restart this MCP server to re-run workspace registration.`,
      );
    case 'SEARCH_UNAVAILABLE':
      return new Error('Grepmind search is not available on this server.');
    case 'SEARCH_FAILED':
    case 'RETRYABLE_BACKEND_ERROR':
      return new Error('Grepmind search failed. Try again shortly.');
    case 'QUOTA_CONFIG_INVALID':
      return new Error(
        'Grepmind quota configuration needs support before search can continue.',
      );
    default:
      return null;
  }
}

function formatQuotaExceededMessage(error: AgentRuntimeClientError): string {
  const nextAction = findDetailValue(error.details, 'nextAction');
  if (nextAction === 'wait_for_reset') {
    const resetAt = findDetailValue(error.details, 'resetAt');
    return typeof resetAt === 'string' && resetAt
      ? `Grepmind search quota is exhausted. Retry after the quota resets at ${resetAt}.`
      : 'Grepmind search quota is exhausted. Retry after the quota resets.';
  }
  if (nextAction === 'reduce_usage') {
    return 'Grepmind search quota is exhausted. Reduce usage or try a smaller search later.';
  }
  return 'Grepmind search quota is exhausted. Contact support to continue.';
}

function formatBackpressureMessage(error: AgentRuntimeClientError): string {
  const retryAfterMs = findDetailValue(error.details, 'retryAfterMs');
  if (
    typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    return `Grepmind runtime is busy. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`;
  }
  return 'Grepmind runtime is busy. Retry shortly.';
}

function findDetailValue(details: unknown, key: string, depth = 0): unknown {
  if (
    !details ||
    typeof details !== 'object' ||
    Array.isArray(details) ||
    depth > 4
  ) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  if (key in record) {
    return record[key];
  }
  if ('quota' in record) {
    const fromQuota = findDetailValue(record.quota, key, depth + 1);
    if (fromQuota !== undefined) {
      return fromQuota;
    }
  }
  if ('details' in record) {
    return findDetailValue(record.details, key, depth + 1);
  }
  return undefined;
}

function isSearchIndexNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not synced yet|search cannot run|index is not ready/i.test(message);
}
