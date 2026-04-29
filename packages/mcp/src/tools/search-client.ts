import path from 'node:path';
import {
  AgentRuntimeClientError,
  isRuntimeUnavailableError,
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
}

export interface ResponseMeta {
  tokens_approx: number;
  truncated?: boolean;
  returned_results?: number;
  [key: string]: unknown;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_SEARCH_LIMIT = 10;
const FILTER_OVERFETCH_MULTIPLIER = 5;
const MIN_FILTER_OVERFETCH_LIMIT = 50;
const MAX_FILTER_OVERFETCH_LIMIT = 200;

export async function searchCode(params: {
  query: string;
  mode: 'semantic' | 'text';
  target?: 'code' | 'docs';
  limit?: number;
  threshold?: number;
  path?: string;
  tags?: string[];
}): Promise<SearchResponse> {
  if (params.mode !== 'semantic') {
    throw new Error(
      'Local agent MCP search supports semantic mode only. Use code_search.',
    );
  }

  const workspaceContext = getMcpWorkspaceContext();

  try {
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
    const response = await getReadyAgentRuntimeClient().searchHead({
      bindingId: workspaceContext.bindingId,
      query: params.query,
      target: params.target ?? 'code',
      limit: searchLimit,
      threshold: params.threshold,
      rerank: true,
      tags: normalizeTags(params.tags),
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
  };
}

function shouldOverfetch(params: { path?: string; tags?: string[] }): boolean {
  return Boolean(params.path?.trim()) || normalizeTags(params.tags).length > 0;
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

  if (isSearchIndexNotReadyError(error)) {
    return new Error(
      `Search index is not ready yet for workspace ${resolvedWorkspacePath} (binding #${workspaceContext.bindingId}). Wait for Grepmind background sync to finish, then retry. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isSearchIndexNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not synced yet|search cannot run|index is not ready/i.test(message);
}
