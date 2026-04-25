// Code search via local grepmind agent runtime

import { z } from 'zod';
import {
  searchCode,
  estimateTokens,
  type SearchResult,
  type ResponseMeta,
} from './search-client.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

export const codeSearchSchema = z.object({
  workspacePath: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the agent project root/workspace. Use your current project root, not the MCP server cwd.',
    ),
  query: z
    .string()
    .describe(
      'Describe what the code does in natural language (e.g., "validate user input", "handle HTTP errors")',
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
    .describe('Min similarity 0-1 (default: 0.5). Lower = more results'),
  path: z
    .string()
    .optional()
    .describe('Filter by path prefix (e.g., "src/api")'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Filter docs by tags (e.g., ["architecture", "guide"])'),
  compact: z
    .boolean()
    .optional()
    .describe('Return only signatures, not full code'),
});

export type CodeSearchInput = z.infer<typeof codeSearchSchema>;

function formatCompactResult(r: SearchResult, index: number): string {
  const nameInfo = r.symbol.name || r.symbol.path.split('/').pop() || 'unknown';
  const typeInfo = r.symbol.type === 'file' ? '' : ` [${r.symbol.type}]`;
  const signatureLine = r.symbol.signature
    ? `   \`${r.symbol.signature}\``
    : '';
  const tagsInfo = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';

  const lines = [
    `## ${index + 1}. ${nameInfo}${typeInfo}${tagsInfo} (similarity: ${r.score.toFixed(2)})`,
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

  let text = `## ${index + 1}. ${location}${typeInfo}${nameInfo} (similarity: ${r.score.toFixed(2)})\n`;

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
    const { results } = await searchCode({
      workspacePath: input.workspacePath,
      query: input.query,
      mode: 'semantic',
      target: input.target,
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      threshold: input.threshold ?? 0.5,
      path: input.path,
      tags: input.tags,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No local agent HEAD results found matching the description. Try rephrasing or lowering threshold.',
          },
        ],
      };
    }

    const formatted = results.map((r, i) =>
      input.compact ? formatCompactResult(r, i) : formatFullResult(r, i),
    );

    const responseText = formatted.join('\n\n---\n\n');
    const requestedLimit = input.limit ?? DEFAULT_SEARCH_LIMIT;

    return {
      content: [{ type: 'text', text: responseText }],
      _meta: {
        tokens_approx: estimateTokens(responseText),
        truncated: results.length >= requestedLimit,
        returned_results: results.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
