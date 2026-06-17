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
  focus: ContextLayerFocus;
  searchResults: SearchResult[];
  docsResults: SearchResult[];
  fileSummaries: ContextLayerFileSummaryRecord[];
  exactPatterns: string[];
  searchWarnings: string[];
}

export function buildContextLayerAggregatePrompt(
  input: ContextLayerAggregatePromptInput,
): string {
  return `You are a senior context aggregation subagent for Grepmind.

Goal:
Prepare one repository-level context_pack for the main coding agent by
aggregating primary code_search hits and per-file summaries.

Instruction:
- Prepare context for the main coding agent.
- Use the provided search hits and file summaries as the primary evidence.
- Use a small targeted Grepmind code_search call when a key missing anchor needs verification.
- Mark inference explicitly when a relationship is inferred rather than directly proven.
- Include failed, timed-out, or truncated file summaries as gaps.
- Put likely/probably/appears-to style claims in an "Inferences:" line.
- Use medium or low confidence when important failed, timed-out, or truncated summaries remain unresolved.

Workspace:
${input.workspacePath}

Focus:
${input.focus}

Search context:
- Handler exact search patterns: ${formatExactPatterns(input.exactPatterns)}
- Handler search warnings: ${formatSearchWarnings(input.searchWarnings)}

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

Critical missing or low-confidence coverage:
${formatCriticalCoverage(input.fileSummaries)}

Per-file summaries:
${formatFileSummaries(input.fileSummaries)}

Aggregation protocol:
1. Answer the user's actual question in Answer.
2. Before finalizing, identify the top 1-3 claims that determine the answer. For each claim without direct file:line support, run one targeted Grepmind code_search with exact.pattern, path, and contextLines when it would verify a key missing anchor. Move unverified claims to Inferences or Gaps.
3. Prefer Required Snippets and line anchors from successful relevant file summaries.
4. Treat summaries marked "relevant: no" as weak matches: mention them only when their exclusion is important.
5. Use primary search hits to preserve original score/order and to mention relevant weak, failed, timed-out, or truncated files as gaps.
6. Deduplicate repeated facts and repeated paths.
7. Include docs context only if Docs code_search hits prove docs. Otherwise write exactly "No relevant docs found".
8. Every important claim must have a nearby file:line anchor or be marked "Inference:".
9. Failed, timed-out, or truncated file summaries are not fatal, but their missing coverage must be visible in Evidence Quality when relevant.

Required output:
Normal successful research must return a context_pack.

Return markdown with exactly these headings, in exactly this order.
Start with "# context_pack".
Place "## Answer" immediately after "# context_pack".
Use only the listed headings.
Every section must contain concise content.
Use bullets and numbered lists inside sections.

# context_pack

## Answer

Compact but complete answer to the user query. Use these labels inside the
section:
- Proven: claims backed by nearby file:line anchors.
- Inferences: relationships that are reasoned from anchors but not directly
  proven, or "None."
- Gaps: missing files, failed summaries, unclear call paths, or "None."

Use enough detail that the main agent can understand the result without
rereading Code Context first, while avoiding repeated snippets.

## Evidence Quality

- Proven anchors: concise count/list of the strongest file:line anchors.
- Inferences: concise list or "None."
- Gaps: missing or unverified coverage, especially failed/timed-out/truncated summaries.
- Failed or truncated summaries: list path and reason, or "None."
- Confidence: high|medium|low; one sentence explaining why. Confidence must be
  "medium" or "low" when important failed/timed-out/truncated summaries remain
  unresolved.

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

function formatExactPatterns(patterns: string[]): string {
  if (patterns.length === 0) {
    return 'None.';
  }
  return patterns.map((pattern) => `\`${pattern}\``).join(', ');
}

function formatSearchWarnings(warnings: string[]): string {
  if (warnings.length === 0) {
    return 'None.';
  }
  return warnings.map((warning) => `- ${warning}`).join('\n');
}

function formatCriticalCoverage(
  summaries: ContextLayerFileSummaryRecord[],
): string {
  const risky = summaries
    .filter(
      (summary) =>
        summary.summaryMarkdown == null ||
        summary.truncated === true ||
        summary.timeout === true,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (risky.length === 0) {
    return '- None.';
  }

  return risky
    .map((summary) => {
      const reason =
        summary.summaryMarkdown == null
          ? summary.timeout === true
            ? 'timeout'
            : `failed: ${summary.error ?? 'unknown error'}`
          : 'truncated';
      return `- \`${summary.path}\` score=${summary.score.toFixed(2)}; ${reason}`;
    })
    .join('\n');
}
