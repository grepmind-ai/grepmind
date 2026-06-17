import type { ContextLayerFocus } from './context-layer-types.js';
import type { SearchResult } from './search-client.js';

export interface ContextLayerFileSummaryPromptInput {
  workspacePath: string;
  query: string;
  originalQuery?: string;
  focus: ContextLayerFocus;
  result: SearchResult;
  relatedResults: SearchResult[];
}

export function buildContextLayerFileSummaryPrompt(
  input: ContextLayerFileSummaryPromptInput,
): string {
  return `You are a senior read-only file research subagent for Grepmind.

Goal:
Prepare a concise file_summary for one code_search result so a later aggregator
can build a repository-level context_pack.

Repository rules:
- Do not edit files.
- Do not run test, tsc, install, git reset, git push, git checkout, git rebase.
- Do not start dev servers.
- Do not kill processes.
- Use only Grepmind code_search for repository research. Do not use any other MCP tool.
- Do not set code_search.rerank unless reranked ordering is necessary for a specific follow-up search; the default must remain disabled.
- Do not run shell commands or direct filesystem inspection commands such as rg, grep, sed, nl, cat, find, ls, or git.
- Do not call context_layer or any other recursive context_layer tool.
- Do not solve the coding task. Prepare context only.
- Keep the summary grounded in line anchors from code_search.
- If code_search cannot verify a claim, mark it as "Inference:".
- Return only decision-useful context. Avoid generic file descriptions.

Workspace:
${input.workspacePath}

Focus:
${input.focus}

Refined user query:
${input.query}

Original query:
${input.originalQuery?.trim() || input.query}

Primary code_search result:
${formatSearchResult(input.result)}

Related same-file results:
${formatRelatedResults(input.relatedResults)}

Research protocol:
1. Use the primary result as the entry point.
2. If the preview is insufficient, make targeted code_search calls with exact.pattern, path, globs, and contextLines for symbols in this same file.
3. You may make a small number of code_search calls for directly connected symbols in nearby files only when the relationship is necessary to explain this file.
4. Prefer exact anchors and short evidence snippets.
5. Decide whether the file is relevant to the refined query.
6. For a relevant file, include only the necessary code snippets, line anchors, and a short explanation of why each snippet matters.
7. For an irrelevant file, return a compact summary: relevance score, "Not relevant." for Required Snippets, and one short reason.

Required output:
Return markdown with exactly these headings, in exactly this order.
Do not include prose before "# file_summary".
Do not include prose between "# file_summary" and "## File".
Do not add any other markdown headings.
Every section must contain concise content.

# file_summary

## File

Path and primary symbol or region.

## Relevance

One line: \`score: N/100; relevant: yes|no; reason: ...\`.

## Required Snippets

For relevant files only:
- \`path/to/file.ts:123\` - why this snippet is necessary.
\`\`\`ts
short code snippet from code_search, no full-file dump
\`\`\`

For irrelevant files, write exactly:
Not relevant.

## Explanation

For relevant files: explain how the snippets answer the query and list any gaps.
For irrelevant files: one short sentence explaining why the match should be ignored.
`;
}

function formatSearchResult(result: SearchResult): string {
  return JSON.stringify(
    {
      path: result.symbol.relativePath,
      symbol: {
        name: result.symbol.name,
        type: result.symbol.type,
        signature: result.symbol.signature,
        startLine: result.symbol.startLine,
        endLine: result.symbol.endLine,
        parentSymbol: result.symbol.parentSymbol,
      },
      tags: result.tags,
      score: result.score,
      previewText: result.content,
    },
    null,
    2,
  );
}

function formatRelatedResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'None.';
  }

  return results.map(formatSearchResult).join('\n\n---\n\n');
}
