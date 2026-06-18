export type SearchTarget = 'code' | 'docs';
export type SearchMode = 'vector' | 'fts' | 'hybrid';

export interface SearchFilters {
  connectionId?: number;
  bindingId: number;
  revisionId: number;
  path?: string;
  tags?: string[];
}

export interface SearchQuery {
  mode: SearchMode;
  limit: number;
  threshold?: number;
  target?: SearchTarget;
  text?: string;
  vector?: number[];
  filters: SearchFilters;
  fuzziness?: number;
  phraseMatch?: boolean;
  phraseSlop?: number;
  vectorWeight?: number;
  ftsWeight?: number;
}

export interface SearchChunkPointer {
  bindingId: number;
  revisionId: number;
  fileId: number;
  chunkId: string;
  target: SearchTarget;
  score: number;
}

export interface SearchResultItem {
  chunkId: string;
  artifactRef: string | null;
  branch: string;
  target: SearchTarget;
  path: string;
  relativePath: string;
  previewText: string;
  score: number;
  symbol: {
    id: string;
    name: string;
    type: string;
    signature: string | null;
    docstring: string | null;
    startLine: number;
    endLine: number;
    parentSymbol: string | null;
  };
  tags: string[];
}

export interface SearchRequestPayload {
  requestId: string;
  bindingId: number;
  revisionId: number;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  path?: string;
  tags?: string[];
}

export interface SearchResponseMeta {
  bindingId: number;
  revisionId: number;
  durationMs: number;
  totalResults: number;
  semanticResults?: number;
  rgResults?: number;
  rgTruncated?: boolean;
  rgSource?: 'working_tree';
  rgWarning?: string;
  semanticWarning?: string;
}

export interface SearchResponsePayload {
  requestId: string;
  items: SearchResultItem[];
  meta: SearchResponseMeta;
}

export interface SearchErrorPayload {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
  nextAction?: string | null;
  retryAfterMs?: number | null;
  quota?: unknown;
}

export interface SearchIndexRequestPayload {
  requestId: string;
  bindingId: number;
  revisionId: number;
  query: SearchQuery;
}

export interface SearchIndexResponsePayload {
  requestId: string;
  items: SearchChunkPointer[];
}
