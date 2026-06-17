// Code search via local grepmind agent runtime

import { z } from 'zod';
import {
  searchCode,
  estimateTokens,
  type SearchResult,
  type ResponseMeta,
} from './search-client.js';
import { ensureMcpRuntimePrepared } from '../runtime-context.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;
const MAX_EXACT_PATTERN_LENGTH = 500;
const MAX_GLOB_COUNT = 20;
const MAX_GLOB_LENGTH = 200;
const MAX_CONTEXT_LINES = 10;

export const codeSearchSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        'Describe the code or docs you need. Add exact.pattern when you know an identifier, string, route, config key, error text, import path, function name, or regex anchor.',
      ),
    target: z
      .enum(['code', 'docs'])
      .optional()
      .describe(
        'Search target in the local agent HEAD: "code" (default) or "docs" (markdown/docs files)',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .optional()
      .describe('Max results (default: 10, max: 100)'),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Min semantic score 0-1 (default: 0.5). Lower = more results'),
    path: z
      .string()
      .optional()
      .describe('Filter by path prefix (e.g., "src/api")'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Filter docs by tags (e.g., ["architecture", "guide"])'),
    exact: z
      .object({
        pattern: z.string().min(1).max(MAX_EXACT_PATTERN_LENGTH),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
      })
      .optional()
      .describe(
        'Optional exact local rg signal. Use pattern for identifiers, strings, routes, config keys, imports, error text, or regex anchors.',
      ),
    globs: z
      .array(z.string().min(1).max(MAX_GLOB_LENGTH))
      .max(MAX_GLOB_COUNT)
      .optional()
      .describe('Optional local rg glob scopes. Not raw rg flags.'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTEXT_LINES)
      .optional()
      .describe(
        'Local rg context lines around exact matches (default: 2, max: 10)',
      ),
    compact: z
      .boolean()
      .optional()
      .describe('Return only signatures, not full code'),
  })
  .strict();

export type CodeSearchInput = z.infer<typeof codeSearchSchema>;

function formatCompactResult(r: SearchResult, index: number): string {
  const nameInfo = r.symbol.name || r.symbol.path.split('/').pop() || 'unknown';
  const typeInfo = r.symbol.type === 'file' ? '' : ` [${r.symbol.type}]`;
  const signatureLine = r.symbol.signature
    ? `   \`${r.symbol.signature}\``
    : '';
  const tagsInfo = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';

  const lines = [
    `## ${index + 1}. ${nameInfo}${typeInfo}${tagsInfo} (score: ${r.score.toFixed(2)})`,
    `   ${r.symbol.relativePath}:${r.symbol.startLine}`,
  ];
  if (signatureLine) {
    lines.push(signatureLine);
  }

  return lines.join('\n');
}

function formatFullResult(r: SearchResult, index: number): string {
  const location = `${r.symbol.relativePath}:${r.symbol.startLine}-${r.symbol.endLine}`;
  const typeInfo = r.symbol.type === 'file' ? '' : ` [${r.symbol.type}]`;
  const nameInfo = r.symbol.name ? ` ${r.symbol.name}` : '';

  let text = `## ${index + 1}. ${location}${typeInfo}${nameInfo} (score: ${r.score.toFixed(2)})\n`;

  if (r.tags?.length) {
    text += `\n**Tags:** ${r.tags.join(', ')}\n`;
  }

  if (r.symbol.signature) {
    text += `\n**Signature:** \`${r.symbol.signature}\`\n`;
  }

  if (r.symbol.docstring) {
    text += `\n**Docstring:**\n${r.symbol.docstring}\n`;
  }

  if (r.symbol.parentSymbol) {
    text += `\n**Parent:** ${r.symbol.parentSymbol}`;
  }

  // Detect language from file extension
  const ext = r.symbol.path.split('.').pop() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    rb: 'ruby',
  };
  const lang = langMap[ext] || ext;

  text += `\n\n\`\`\`${lang}\n${r.content}\n\`\`\``;

  return text;
}

export async function codeSearchTool(input: CodeSearchInput): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  _meta?: ResponseMeta;
}> {
  try {
    await ensureMcpRuntimePrepared();
    const { results, meta } = await searchCode({
      query: input.query,
      target: input.target,
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      threshold: input.threshold ?? 0.5,
      path: input.path,
      tags: input.tags,
      exact: input.exact,
      globs: input.globs,
      contextLines: input.contextLines,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No local agent HEAD results found. Try rephrasing, lowering threshold, adjusting path/tags, or adding exact.pattern when you know a concrete identifier or string.',
          },
        ],
        _meta: toResponseMeta('', results.length, input.limit, meta),
      };
    }

    const formatted = results.map((r, i) =>
      input.compact ? formatCompactResult(r, i) : formatFullResult(r, i),
    );

    const responseText = formatted.join('\n\n---\n\n');
    const requestedLimit = input.limit ?? DEFAULT_SEARCH_LIMIT;

    return {
      content: [{ type: 'text', text: responseText }],
      _meta: toResponseMeta(responseText, results.length, requestedLimit, meta),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

function toResponseMeta(
  responseText: string,
  returnedResults: number,
  requestedLimit: number | undefined,
  runtimeMeta: {
    semanticResults?: number;
    rgResults?: number;
    rgTruncated?: boolean;
    rgSource?: 'working_tree';
    rgWarning?: string;
    semanticWarning?: string;
  },
): ResponseMeta {
  const limit = requestedLimit ?? DEFAULT_SEARCH_LIMIT;
  return {
    tokens_approx: estimateTokens(responseText),
    truncated: returnedResults >= limit,
    returned_results: returnedResults,
    semantic_results: runtimeMeta.semanticResults,
    rg_results: runtimeMeta.rgResults,
    rg_truncated: runtimeMeta.rgTruncated,
    rg_source: runtimeMeta.rgSource,
    rg_warning: runtimeMeta.rgWarning,
    semantic_warning: runtimeMeta.semanticWarning,
  };
}
