import type { ContextLayerFocus } from './context-layer-types.js';

export interface ContextLayerResearchPromptInput {
  workspacePath: string;
  query: string;
  originalQuery?: string;
  refinerAssumptions?: string[];
  focus: ContextLayerFocus;
  maxSearchCalls: number;
}

export function buildContextLayerResearchPrompt(
  input: ContextLayerResearchPromptInput,
): string {
  return `You are the single read-only research subagent for Grepmind MCP context_layer.

Goal:
Prepare one repository-level context_pack for the main coding agent.

Instruction:
- Use Grepmind code_search yourself to gather the code and docs context.
- Use at most ${input.maxSearchCalls} total code_search calls.
- The first code_search call must search code for the refined query.
- Spend one code_search call on docs when docs, architecture notes, README content, or product contracts may affect the answer.
- Use exact.pattern, globs, path, and contextLines when identifiers, routes, config keys, error text, imports, file names, or regex anchors are known.
- Read repository files directly when code_search evidence needs verification or surrounding context.
- Do not call context_layer, grepmind_agent_status, or nested agents.
- Do not modify files.
- If code_search is unavailable or returns weak coverage, return a context_pack with explicit Gaps and low confidence instead of inventing evidence.
- Mark inference explicitly when a relationship is inferred rather than directly proven.
- Include failed, unavailable, or low-confidence search coverage as gaps.

Workspace:
${input.workspacePath}

Focus:
${input.focus}

Refined user query:
${input.query}

Original query:
${input.originalQuery?.trim() || input.query}

Prompt-refiner assumptions:
${formatRefinerAssumptions(input.refinerAssumptions)}

Research protocol:
1. Run code_search for the refined query.
2. Run targeted follow-up code_search calls only when they close a concrete gap.
3. Inspect files locally for decision-critical anchors and surrounding code.
4. Build a draft answer from proven file:line evidence.
5. Final pass in this same agent: audit the top 1-3 claims that determine the answer. Move claims without direct file:line support to Inferences or Gaps, downgrade confidence when coverage is weak, and remove unsupported details.
6. Deduplicate repeated facts and repeated paths. Assign each evidence anchor exactly one evidence ID in Code Context or Docs Context, then cite only those IDs from Answer, Evidence Quality, Sufficiency, and Flow.
7. Include docs context only if code_search or file inspection proves docs. Otherwise write exactly "No relevant docs found".
8. In Sufficiency, decide whether this context is enough for the calling agent to answer the original query. If not enough, suggest 1-3 precise next context queries.

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
- Proven: direct answer claims backed by evidence IDs such as [E1], [E2], or
  [D1]. Do not include file:line anchors or snippets here.
- Inferences: relationships that are reasoned from anchors but not directly
  proven, with evidence IDs when useful, or "None."
- Gaps: missing files, failed searches, unclear call paths, or "None." Cite gap
  IDs such as [G1] when there are gaps.

Use enough detail that the main agent can understand the result without
rereading Code Context first. Avoid repeating evidence text, snippets, or
file:line anchors; cite evidence IDs instead.

## Evidence Quality

- Proven anchors: concise count/list of the strongest evidence IDs, for example
  "[E1]-[E8], [D1]". Do not repeat path:line anchors.
- Inferences: concise list of inference IDs or "None."
- Gaps: concise list of gap IDs, especially failed, unavailable, or weak search
  coverage, or "None."
- Failed or truncated summaries: use this label for compatibility. List
  failed/unavailable/weak search IDs and truncated file-read IDs, or "None."
- Confidence: high|medium|low; one sentence explaining why. Confidence must be
  "medium" or "low" when important failed, unavailable, or weak coverage remains
  unresolved.

## Sufficiency

- Enough to answer: yes|no
- Missing context: concise list with gap IDs, or "None."
- Suggested next context queries: "None." or 1-3 precise follow-up queries.
- Stop reason: why the provided context is sufficient or which residual gap remains.

## Code Context

This is the single evidence register for code anchors. Each bullet must define a
stable ID exactly once:
- [E1] \`path/to/file.ts:123\` - verified fact and why this code matters. Evidence snippet: short snippet or paraphrase from code_search or file inspection.
- [E2] \`path/to/other.ts:45\` - Inference: relationship to another verified anchor, if relevant.
- [G1] Gap: missing code coverage, failed search, or unclear call path, if relevant.

## Docs Context

- [D1] \`docs/path.md:45\` - relevant product, architecture, or API contract.
- If there are no relevant docs after reviewing provided material: \`No relevant docs found\`.

## Flow

1. Entry point: concrete caller, route, command, stage, or service, citing evidence IDs only.
2. Data movement: important objects, tables, IDs, keys, files, or events, citing evidence IDs only.
3. Validation or side effect: guards, permissions, status changes, writes, external calls, citing evidence IDs only.
4. Persistence or response: saved rows/files, returned DTOs, emitted output, cleanup, or retention, citing evidence IDs only.
`;
}

function formatRefinerAssumptions(assumptions: string[] | undefined): string {
  if (assumptions == null || assumptions.length === 0) {
    return '- None.';
  }
  return assumptions.map((assumption) => `- ${assumption}`).join('\n');
}
