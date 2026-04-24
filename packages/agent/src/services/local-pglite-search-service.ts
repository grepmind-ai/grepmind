import type {
  SearchChunkPointer,
  SearchIndexRequestPayload,
  SearchMode,
  SearchQuery,
  SearchTarget,
} from '../backend/contracts/index.js';
import type { AgentDb } from '../db/schema.js';
import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';

interface SearchRow {
  binding_id: number | string;
  revision_id: number | string;
  file_id: number | string;
  chunk_id: string;
  score: number | string;
}

export interface LocalPgliteSearchServiceOptions {
  db: AgentDb;
  logger?: AgentLogger;
}

export class LocalPgliteSearchService {
  private readonly db: AgentDb;
  private readonly logger: AgentLogger;

  constructor(options: LocalPgliteSearchServiceOptions) {
    this.db = options.db;
    this.logger = options.logger ?? noopAgentLogger;
  }

  async search(input: SearchIndexRequestPayload): Promise<SearchChunkPointer[]> {
    const request = this.validateRequest(input);
    const target = request.query.target;
    const vectorLiteral = toVectorLiteral(request.query.vector);
    const limit = request.query.limit;

    if (target === 'code' && request.query.filters.tags.length > 0) {
      this.logger.trace(
        'runtime',
        `index-search requestId=${request.requestId} bindingId=${request.bindingId} revisionId=${request.revisionId} target=code tags-filtered-empty`,
      );
      return [];
    }

    const tableName = target === 'docs' ? 'docs_chunks' : 'code_chunks';
    const params: Array<number | string> = [
      request.bindingId,
      request.revisionId,
      vectorLiteral,
    ];
    const whereClauses = [
      'binding_id = $1',
      'revision_id = $2',
    ];

    if (target === 'docs' && request.query.filters.tags.length > 0) {
      const tagPlaceholders = request.query.filters.tags.map((tag) => {
        params.push(tag);
        return `$${params.length}`;
      });
      whereClauses.push(
        `EXISTS (
          SELECT 1
          FROM docs_chunk_tags dct
          WHERE dct.row_id = ${tableName}.row_id
            AND dct.tag IN (${tagPlaceholders.join(', ')})
        )`,
      );
    }

    params.push(limit);
    const rows = await this.db.query<SearchRow>(
      `
      SELECT
        binding_id,
        revision_id,
        file_id,
        chunk_id,
        1 - (embedding <=> CAST($3 AS vector)) AS score
      FROM ${tableName}
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY embedding <=> CAST($3 AS vector) ASC
      LIMIT $${params.length}
      `,
      params,
    );

    return rows.rows.map((row) => ({
      bindingId: Number(row.binding_id),
      revisionId: Number(row.revision_id),
      fileId: Number(row.file_id),
      chunkId: row.chunk_id,
      target,
      score: Number(row.score),
    }));
  }

  private validateRequest(input: SearchIndexRequestPayload): ValidatedSearchRequest {
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    if (!requestId) {
      throw new Error('search.index.request requires a non-empty requestId');
    }

    const bindingId = requirePositiveInteger(input.bindingId, 'bindingId');
    const revisionId = requirePositiveInteger(input.revisionId, 'revisionId');
    const query = validateSearchQuery(input.query, bindingId, revisionId);

    return {
      requestId,
      bindingId,
      revisionId,
      query,
    };
  }
}

interface ValidatedSearchRequest {
  requestId: string;
  bindingId: number;
  revisionId: number;
  query: ValidatedSearchQuery;
}

interface ValidatedSearchQuery extends Omit<SearchQuery, 'mode' | 'target' | 'vector' | 'filters' | 'limit'> {
  mode: SearchMode;
  target: SearchTarget;
  vector: number[];
  limit: number;
  filters: {
    bindingId: number;
    revisionId: number;
    tags: string[];
  };
}

function validateSearchQuery(
  query: SearchQuery,
  bindingId: number,
  revisionId: number,
): ValidatedSearchQuery {
  if (!query || typeof query !== 'object') {
    throw new Error('search.index.request requires a query payload');
  }
  if (query.mode !== 'vector') {
    throw new Error('Local agent search supports vector mode only');
  }
  if (query.target !== 'code' && query.target !== 'docs') {
    throw new Error('Local agent search requires a target of code or docs');
  }
  if (!Array.isArray(query.vector) || query.vector.length === 0 || query.vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error('Local agent search requires a finite query vector');
  }

  const limit = requirePositiveInteger(query.limit, 'query.limit');
  const filtersBindingId = requirePositiveInteger(query.filters?.bindingId, 'query.filters.bindingId');
  const filtersRevisionId = requirePositiveInteger(query.filters?.revisionId, 'query.filters.revisionId');
  if (filtersBindingId !== bindingId) {
    throw new Error('search.index.request bindingId does not match query.filters.bindingId');
  }
  if (filtersRevisionId !== revisionId) {
    throw new Error('search.index.request revisionId does not match query.filters.revisionId');
  }

  return {
    ...query,
    mode: 'vector',
    target: query.target,
    vector: query.vector,
    limit,
    filters: {
      bindingId: filtersBindingId,
      revisionId: filtersRevisionId,
      tags: normalizeTags(query.filters?.tags),
    },
  };
}

function normalizeTags(value: string[] | undefined): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return [...new Set(
    value
      .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
      .filter((entry) => entry.length > 0),
  )];
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
