import type { ContextLayerFocus } from './context-layer-types.js';
import type { SearchResult } from './search-client.js';

export interface ContextLayerFileSummaryPromptInput {
  workspacePath: string;
  query: string;
  originalQuery?: string;
  focus: ContextLayerFocus;
  result: SearchResult;
  relatedResults: SearchResult[];
  sourceFile?: ContextLayerSourceFileContext;
}

export interface ContextLayerSourceFileContext {
  path: string;
  content: string;
  truncated: boolean;
  byteLength: number;
}

export function buildContextLayerFileSummaryPrompt(
  input: ContextLayerFileSummaryPromptInput,
): string {
  return `You are a senior file research subagent for Grepmind.

Goal:
Prepare a concise file_summary for one code_search result so a later aggregator
can build a repository-level context_pack.

Instruction:
- Prepare context for this file only.
- Use only the provided search hit, same-file related hits, and disk file content as evidence.
- Do not call Grepmind MCP tools, code_search, context_layer, or any nested agents.
- Mark claims that the provided evidence cannot verify as "Inference:".
- Mark cross-file control flow or data flow as "Inference:" unless the provided evidence shows both sides.
- Return decision-useful context and avoid generic file descriptions.

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

Disk file content:
${formatSourceFile(input.sourceFile)}

Research protocol:
1. Use the primary result as the entry point.
2. When disk file content is provided, use it to understand the full file before judging relevance.
3. If the preview and disk content are insufficient, record the missing coverage as a Gap instead of searching.
4. Prefer exact anchors and short evidence snippets from the provided material.
5. Decide whether the file is relevant to the refined query.
6. For a relevant file, include only the necessary code snippets, line anchors, and a short explanation of why each snippet matters.
7. In Explanation for relevant files, explicitly label "Verified:", "Inference:", and "Gaps:".
8. For an irrelevant file, return a compact summary: relevance score, "Not relevant." for Required Snippets, and one short reason.

Required output:
Return markdown with exactly these headings, in exactly this order.
Start with "# file_summary".
Place "## File" immediately after "# file_summary".
Use only the listed headings.
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

For relevant files: explain how the snippets answer the query using "Verified:", "Inference:", and "Gaps:" labels. Use "Inference: None." and "Gaps: None." when appropriate.
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

function formatSourceFile(
  sourceFile: ContextLayerSourceFileContext | undefined,
): string {
  if (sourceFile == null) {
    return 'Not provided.';
  }

  const truncated = sourceFile.truncated ? 'yes' : 'no';
  const fence = markdownFenceFor(sourceFile.content);
  return `Path: ${sourceFile.path}
Bytes: ${sourceFile.byteLength}
Truncated: ${truncated}
${fence}
${sourceFile.content}
${fence}`;
}

function markdownFenceFor(content: string): string {
  let fence = '```';
  while (content.includes(fence)) {
    fence += '`';
  }
  return fence;
}
