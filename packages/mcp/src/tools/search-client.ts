// Shared client for grepmind local agent search RPC

import os from 'node:os';
import path from 'node:path';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  isRuntimeUnavailableError,
  type SearchHeadRpcResult,
  type SearchResultItem,
} from '@grepmind/agent-rpc';

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

const DEFAULT_AGENT_DATA_DIR = path.join(os.homedir(), '.grepmind-agent');
let cachedAgentDataDir: string | null = null;
let cachedAgentRuntimeClient: AgentRuntimeClient | null = null;

function getAgentDataDir(): string {
  const configured = process.env.GREPMIND_AGENT_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_AGENT_DATA_DIR;
}

function createAgentRuntimeClient(): AgentRuntimeClient {
  const dataDir = getAgentDataDir();
  if (!cachedAgentRuntimeClient || cachedAgentDataDir !== dataDir) {
    cachedAgentDataDir = dataDir;
    cachedAgentRuntimeClient = new AgentRuntimeClient(dataDir);
  }

  return cachedAgentRuntimeClient;
}

export async function searchCode(params: {
  workspacePath: string;
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

  try {
    const workspacePath = path.resolve(params.workspacePath);
    const response = await createAgentRuntimeClient().searchHead({
      workspacePath,
      query: params.query,
      target: params.target ?? 'code',
      limit: params.limit,
      threshold: params.threshold,
      rerank: true,
    });

    return toSearchResponse(response, {
      path: params.path,
      tags: params.tags,
    });
  } catch (error) {
    throw normalizeAgentSearchError(error, params.workspacePath);
  }
}

function toSearchResponse(
  response: SearchHeadRpcResult,
  filters: {
    path?: string;
    tags?: string[];
  },
): SearchResponse {
  return {
    results: response.items
      .filter((item) => matchesPathFilter(item, filters.path))
      .filter((item) => matchesTagsFilter(item, filters.tags))
      .map(toSearchResult),
  };
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
  workspacePath: string,
): Error {
  const resolvedWorkspacePath = path.resolve(workspacePath);

  if (isRuntimeUnavailableError(error)) {
    const dataDir = getAgentDataDir();
    return new Error(
      `Local Grepmind agent runtime is not running for ${dataDir}. ` +
        `Start it with "grepmind agent run --data-dir ${dataDir}" and retry. ` +
        'If this workspace is not registered yet, register it with "grepmind agent register --workspace <path>".',
    );
  }

  if (error instanceof AgentRuntimeClientError && error.code === 'NOT_FOUND') {
    return new Error(
      `${error.message}. Register this workspace with "grepmind agent register --workspace ${resolvedWorkspacePath}" and make sure it is synced.`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}
