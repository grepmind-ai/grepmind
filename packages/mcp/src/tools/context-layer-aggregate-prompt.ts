import type { ContextLayerFocus } from './context-layer-types.js';
import type { SearchResult } from './search-client.js';

export interface ContextLayerFileSummaryRecord {
  path: string;
  score: number;
  summaryMarkdown?: string;
  error?: string;
  runtimeDurationMs?: number;
  truncated?: boolean;
  timeout?: boolean;
}

export interface ContextLayerAggregatePromptInput {
  workspacePath: string;
  query: string;
  originalQuery?: string;
  refinerAssumptions?: string[];
  maxFiles: number;
  maxSearchCalls: number;
  focus: ContextLayerFocus;
  searchResults: SearchResult[];
  docsResults: SearchResult[];
  fileSummaries: ContextLayerFileSummaryRecord[];
}

export function buildContextLayerAggregatePrompt(
  input: ContextLayerAggregatePromptInput,
): string {
  return `You are a senior read-only context aggregation subagent for Grepmind.

Goal:
Prepare one repository-level context_pack for the main coding agent by
aggregating primary code_search hits and per-file summaries.

Repository rules:
- Do not edit files.
- Do not run test, tsc, install, git reset, git push, git checkout, git rebase.
- Do not start dev servers.
- Do not kill processes.
- Use only the provided search hits and file summaries unless a small targeted Grepmind code_search call is necessary to verify a key missing anchor.
- Do not run shell commands or direct filesystem inspection commands such as rg, grep, sed, nl, cat, find, ls, or git.
- Do not call context_layer or any other recursive context_layer tool.
- Do not solve the coding task. Prepare context only.
- Mark inference explicitly when a relationship is inferred rather than directly proven.
- If a file summary failed or timed out, include that as a gap instead of pretending the file was inspected.

Workspace:
${input.workspacePath}

Focus:
${input.focus}

Limits:
- Max files covered deeply: ${input.maxFiles}.
- Original max code_search calls budget: ${input.maxSearchCalls}.

Refined user query:
${input.query}

Original query:
${input.originalQuery?.trim() || input.query}

Prompt-refiner assumptions:
${formatRefinerAssumptions(input.refinerAssumptions)}

Primary code_search hits:
${formatSearchResults(input.searchResults)}

Docs code_search hits:
${formatSearchResults(input.docsResults)}

Per-file summaries:
${formatFileSummaries(input.fileSummaries)}

Aggregation protocol:
1. Answer the user's actual question in Answer.
2. Prefer Required Snippets and line anchors from successful relevant file summaries.
3. Treat summaries marked "relevant: no" as weak matches: mention them only when their exclusion is important.
4. Use primary search hits to preserve original score/order and to mention relevant weak or failed files as gaps.
5. Deduplicate repeated facts and repeated paths.
6. Include docs context only if Docs code_search hits prove docs. Otherwise write exactly "No relevant docs found".
7. Every important claim should have a nearby file:line anchor or be marked "Inference:".
8. Failed or timed-out file summaries are not fatal, but their missing coverage must be visible where relevant.

Required output:
Normal successful research must return a context_pack.

Return markdown with exactly these headings, in exactly this order.
Do not include prose before "# context_pack".
Do not include prose between "# context_pack" and "## Answer".
Do not add any other markdown headings.
Every section must contain concise content.
Use bullets and numbered lists inside sections. Do not use markdown headings inside sections.

# context_pack

## Answer

Compact but complete answer to the user query. Include the main mechanism, the
important files or symbols, the confidence level, and meaningful gaps. Do not
be terse: use enough detail that the main agent can understand the result
without rereading Code Context first, but avoid repeating every snippet.

## Code Context

- \`path/to/file.ts:123\` - verified fact and why this code matters. Evidence snippet: short snippet or paraphrase from file_summary/search hit.
- \`path/to/other.ts:45\` - Inference: relationship to another verified anchor, if relevant.

## Docs Context

- \`docs/path.md:45\` - relevant product, architecture, or API contract.
- If there are no relevant docs after reviewing provided material: \`No relevant docs found\`.

## Flow

1. Entry point: concrete caller, route, command, stage, or service, with file:line evidence snippet.
2. Data movement: important objects, tables, IDs, keys, files, or events, with file:line evidence snippet.
3. Validation or side effect: guards, permissions, status changes, writes, external calls, with file:line evidence snippet.
4. Persistence or response: saved rows/files, returned DTOs, emitted output, cleanup, or retention, with file:line evidence snippet.
`;
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No primary code_search hits found.';
  }

  return JSON.stringify(
    results.map((result) => ({
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
    })),
    null,
    2,
  );
}

function formatFileSummaries(
  summaries: ContextLayerFileSummaryRecord[],
): string {
  if (summaries.length === 0) {
    return 'No file summaries were produced.';
  }

  return summaries
    .map((summary, index) => {
      if (summary.summaryMarkdown) {
        return `## Summary ${index + 1}: ${summary.path}
Score: ${summary.score.toFixed(2)}
Runtime: ${summary.runtimeDurationMs ?? 0}ms
Truncated: ${summary.truncated === true ? 'yes' : 'no'}

${summary.summaryMarkdown}`;
      }

      return `## Summary ${index + 1}: ${summary.path}
Score: ${summary.score.toFixed(2)}
Runtime: ${summary.runtimeDurationMs ?? 0}ms
Timeout: ${summary.timeout === true ? 'yes' : 'no'}
Error: ${summary.error ?? 'unknown file summary failure'}`;
    })
    .join('\n\n---\n\n');
}

function formatRefinerAssumptions(assumptions: string[] | undefined): string {
  if (assumptions == null || assumptions.length === 0) {
    return '- None.';
  }
  return assumptions.map((assumption) => `- ${assumption}`).join('\n');
}
