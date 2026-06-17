import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensureMcpRuntimePrepared } from '../runtime-context.js';
import {
  runCodexSubagent,
  resolveContextLayerMaxOutputBytes,
  resolveContextLayerTimeoutMs,
} from './codex-subagent-runner.js';
import {
  resolvePromptRefinerTimeoutMs,
  runPromptRefinerSubagent,
} from './codex-prompt-refiner-runner.js';
import { ContextLayerError } from './context-layer-errors.js';
import type { ContextLayerErrorCode } from './context-layer-errors.js';
import {
  resolveContextLayerModel,
  type ResolvedContextLayerModel,
} from './context-layer-model-config.js';
import {
  hashRefinementSessionId,
  hashWorkspacePath,
  incrementContextLayerCounter,
} from './context-layer-observability.js';
import { type ContextLayerFocus } from './context-layer-types.js';
import { buildContextLayerAggregatePrompt } from './context-layer-aggregate-prompt.js';
import {
  buildFanoutTargets,
  resolveContextLayerFanoutConcurrency,
  resolveContextLayerFileMaxOutputBytes,
  resolveContextLayerFileTimeoutMs,
  runContextLayerFileSummaryFanout,
} from './context-layer-fanout-runner.js';
import {
  createRefinementSession,
  deleteRefinementSession,
  getRefinementSession,
  recordRefinementAttempt,
  updateRefinementSessionQuestions,
  type RefinementAgentAnswer,
  type RefinementSession,
} from './context-layer-refinement-session.js';
import {
  toAgentQuestionsResult,
  toErrorResult,
  type ContextLayerResult,
} from './context-layer-results.js';
import type {
  PromptRefinerOutput,
  PromptRefinerQuestion,
} from './prompt-refiner-output.js';
import { searchCode, type SearchResult } from './search-client.js';

export const DEFAULT_MAX_FILES = 30;
export const DEFAULT_MAX_SEARCH_CALLS = 8;
export const DEFAULT_FOCUS = 'implementation';
export const DEFAULT_CONTEXT_LAYER_TOOL_TIMEOUT_BUFFER_SEC = 30;

export const contextLayerSchema = z
  .object({
    query: z.string().min(1).describe('Task or code question to research'),
    model: z
      .object({
        provider: z.enum(['codex', 'claude']).optional(),
        name: z.string().min(1).optional(),
        thinking: z.enum(['low', 'medium', 'high']).optional(),
        speed: z.literal('fast').optional(),
      })
      .strict()
      .optional(),
    maxSearchCalls: z.number().int().min(1).max(20).optional(),
    focus: z
      .enum(['implementation', 'debugging', 'architecture', 'review'])
      .optional(),
    refinementSession: z.string().min(1).optional(),
    agentAnswers: z
      .array(
        z
          .object({
            questionId: z.string().min(1),
            answer: z.string().min(1),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export type ContextLayerInput = z.infer<typeof contextLayerSchema>;

interface RefinementState {
  originalQuery: string;
  additionalCallerContext?: string;
  focus: ContextLayerFocus;
  maxFiles: number;
  maxSearchCalls: number;
  model: ResolvedContextLayerModel;
  session?: RefinementSession;
  previousRefinedQueryDraft?: string;
  previousQuestions?: PromptRefinerQuestion[];
  agentAnswers?: RefinementAgentAnswer[];
}

interface ContextLayerSearchPlan {
  codeResults: SearchResult[];
  docsResults: SearchResult[];
  handlerSearchCalls: number;
  remainingSearchCalls: number;
  exactPatterns: string[];
  warnings: string[];
}

export async function contextLayerTool(
  input: ContextLayerInput,
): Promise<ContextLayerResult> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let maxSearchCalls = input.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS;
  let model: ResolvedContextLayerModel | undefined;
  let refinementSessionId = input.refinementSession;
  let promptRefinerRuntimeDurationMs: number | undefined;
  let researchRuntimeDurationMs: number | undefined;

  incrementContextLayerCounter('context_layer_requested', { requestId });

  try {
    if (process.env.GREPMIND_CONTEXT_LAYER_SUBAGENT === '1') {
      incrementContextLayerCounter('context_layer_recursion_blocked', {
        requestId,
      });
      throw new ContextLayerError(
        'CONTEXT_LAYER_RECURSION_BLOCKED',
        'context_layer cannot be called from a Grepmind context_layer subagent',
      );
    }

    if (input.agentAnswers != null && input.refinementSession == null) {
      throw new ContextLayerError(
        'REFINEMENT_SESSION_REQUIRED',
        'agentAnswers can only be used together with refinementSession.',
      );
    }

    model = resolveContextLayerModel(input.model);
    if (model.provider === 'claude') {
      throw new ContextLayerError(
        'CLAUDE_RUNTIME_NOT_IMPLEMENTED',
        'Claude context_layer runtime is not implemented yet. Use provider=codex.',
      );
    }

    const workspaceContext = await ensureMcpRuntimePrepared();
    const refinementState = resolveRefinementState({
      input,
      workspacePath: workspaceContext.workspacePath,
      model,
      requestId,
    });
    maxSearchCalls = refinementState.maxSearchCalls;
    refinementSessionId =
      refinementState.session?.id ?? input.refinementSession;

    if (
      refinementState.session != null &&
      refinementState.agentAnswers == null
    ) {
      incrementContextLayerCounter('context_layer_agent_questions_returned', {
        requestId,
        sessionHash: hashRefinementSessionId(refinementState.session.id),
        questionCount: refinementState.session.questions.length,
        durationMs: Date.now() - startedAt,
      });
      return toAgentQuestionsResult({
        session: refinementState.session,
        refinerDurationMs: 0,
        runtimeDurationMs: Date.now() - startedAt,
      });
    }

    const refinerTimeoutMs = resolvePromptRefinerTimeoutMs();
    incrementContextLayerCounter('context_layer_prompt_refiner_started', {
      requestId,
      workspaceHash: hashWorkspacePath(workspaceContext.workspacePath),
      sessionHash:
        refinementState.session == null
          ? undefined
          : hashRefinementSessionId(refinementState.session.id),
      timeoutMs: refinerTimeoutMs,
    });

    const refiner = await runPromptRefinerSubagent({
      workspacePath: workspaceContext.workspacePath,
      modelName: refinementState.model.name,
      modelSpeed: refinementState.model.speed,
      modelThinking: refinementState.model.thinking,
      originalQuery: refinementState.originalQuery,
      additionalCallerContext: refinementState.additionalCallerContext,
      previousRefinedQueryDraft: refinementState.previousRefinedQueryDraft,
      previousQuestions: refinementState.previousQuestions,
      agentAnswers: refinementState.agentAnswers,
      timeoutMs: refinerTimeoutMs,
    });
    promptRefinerRuntimeDurationMs = refiner.runtimeDurationMs;
    incrementContextLayerCounter('context_layer_prompt_refiner_completed', {
      requestId,
      durationMs: refiner.runtimeDurationMs,
    });

    if (refiner.output.status === 'needs_agent_answers') {
      const session = upsertQuestionsSession({
        state: refinementState,
        workspacePath: workspaceContext.workspacePath,
        refinement: refiner.output,
      });
      refinementSessionId = session.id;
      incrementContextLayerCounter('context_layer_agent_questions_returned', {
        requestId,
        sessionHash: hashRefinementSessionId(session.id),
        questionCount: session.questions.length,
        durationMs: Date.now() - startedAt,
      });
      return toAgentQuestionsResult({
        session,
        refinerDurationMs: refiner.runtimeDurationMs,
        runtimeDurationMs: Date.now() - startedAt,
      });
    }

    deleteRefinementSession(refinementState.session?.id);
    if (refinementState.session != null) {
      incrementContextLayerCounter(
        'context_layer_refinement_session_completed',
        {
          requestId,
          sessionHash: hashRefinementSessionId(refinementState.session.id),
        },
      );
    }

    const timeoutMs = resolveContextLayerTimeoutMs();
    const maxOutputBytes = resolveContextLayerMaxOutputBytes();
    const fileTimeoutMs = resolveContextLayerFileTimeoutMs();
    const fileMaxOutputBytes = resolveContextLayerFileMaxOutputBytes();
    const fanoutConcurrency = resolveContextLayerFanoutConcurrency();
    const searchPlan = await prepareContextLayerSearch({
      query: refiner.output.refinedQuery,
      maxFiles: refinementState.maxFiles,
      maxSearchCalls: refinementState.maxSearchCalls,
    });
    const fanoutTargets = buildFanoutTargets({
      results: searchPlan.codeResults,
      maxFiles: refinementState.maxFiles,
    });
    const fanout = await runContextLayerFileSummaryFanout({
      requestId,
      workspacePath: workspaceContext.workspacePath,
      query: refiner.output.refinedQuery,
      originalQuery: refinementState.originalQuery,
      focus: refinementState.focus,
      targets: fanoutTargets,
      modelName: refinementState.model.name,
      modelSpeed: refinementState.model.speed,
      modelThinking: refinementState.model.thinking,
      concurrency: fanoutConcurrency,
      timeoutMs: fileTimeoutMs,
      maxOutputBytes: fileMaxOutputBytes,
    });
    const aggregationPrompt = buildContextLayerAggregatePrompt({
      workspacePath: workspaceContext.workspacePath,
      query: refiner.output.refinedQuery,
      originalQuery: refinementState.originalQuery,
      refinerAssumptions: refiner.output.assumptions,
      focus: refinementState.focus,
      searchResults: searchPlan.codeResults,
      docsResults: searchPlan.docsResults,
      fileSummaries: fanout.summaries,
      exactPatterns: searchPlan.exactPatterns,
      searchWarnings: searchPlan.warnings,
    });

    incrementContextLayerCounter('context_layer_aggregation_started', {
      requestId,
      workspaceHash: hashWorkspacePath(workspaceContext.workspacePath),
      fileCount: fanoutTargets.length,
      timeoutMs,
    });
    const result = await runCodexSubagent({
      workspacePath: workspaceContext.workspacePath,
      prompt: aggregationPrompt,
      modelName: refinementState.model.name,
      modelSpeed: refinementState.model.speed,
      modelThinking: refinementState.model.thinking,
      timeoutMs,
      maxOutputBytes,
    });
    researchRuntimeDurationMs =
      fanout.runtimeDurationMs + result.runtimeDurationMs;

    if (result.truncated) {
      incrementContextLayerCounter('context_layer_output_truncated', {
        requestId,
        durationMs: result.runtimeDurationMs,
      });
    }
    incrementContextLayerCounter('context_layer_aggregation_completed', {
      requestId,
      durationMs: result.runtimeDurationMs,
    });

    return {
      content: [{ type: 'text', text: result.contextPackMarkdown }],
      _meta: {
        result_kind: 'context_pack',
        model_provider: refinementState.model.provider,
        model_name: refinementState.model.name,
        model_thinking: refinementState.model.thinking,
        model_speed: refinementState.model.speed,
        max_search_calls: refinementState.maxSearchCalls,
        handler_search_calls: searchPlan.handlerSearchCalls,
        remaining_search_calls: searchPlan.remainingSearchCalls,
        handler_exact_patterns: searchPlan.exactPatterns,
        handler_search_warnings: searchPlan.warnings,
        context_pack_path: result.contextPackPath,
        prompt_refiner_runtime_duration_ms: refiner.runtimeDurationMs,
        research_runtime_duration_ms: researchRuntimeDurationMs,
        fanout_file_count: fanoutTargets.length,
        fanout_completed_count: fanout.summaries.filter(
          (summary) => 'summaryMarkdown' in summary,
        ).length,
        fanout_failed_count: fanout.summaries.filter(
          (summary) => !('summaryMarkdown' in summary),
        ).length,
        fanout_runtime_duration_ms: fanout.runtimeDurationMs,
        aggregation_runtime_duration_ms: result.runtimeDurationMs,
        runtime_duration_ms: Date.now() - startedAt,
        truncated: result.truncated,
        timeout: result.timeout,
      },
    };
  } catch (error) {
    return handleContextLayerError({
      error,
      requestId,
      startedAt,
      model: model ?? input.model,
      maxSearchCalls,
      refinementSessionId,
      promptRefinerRuntimeDurationMs,
      researchRuntimeDurationMs,
    });
  }
}

function handleContextLayerError(input: {
  error: unknown;
  requestId: string;
  startedAt: number;
  model: Parameters<typeof toErrorResult>[1]['model'];
  maxSearchCalls: number;
  refinementSessionId: string | undefined;
  promptRefinerRuntimeDurationMs: number | undefined;
  researchRuntimeDurationMs: number | undefined;
}): ContextLayerResult {
  const normalized = normalizeContextLayerError(input.error);
  recordContextLayerErrorCounter({
    error: normalized,
    requestId: input.requestId,
    refinementSessionId: input.refinementSessionId,
  });

  return toErrorResult(normalized, {
    model: input.model,
    maxSearchCalls: input.maxSearchCalls,
    refinementSession: input.refinementSessionId,
    promptRefinerRuntimeDurationMs:
      input.promptRefinerRuntimeDurationMs ??
      (isPromptRefinerRuntimeError(normalized.code)
        ? normalized.runtimeDurationMs
        : undefined),
    researchRuntimeDurationMs:
      input.researchRuntimeDurationMs ??
      (isResearchRuntimeError(normalized.code)
        ? normalized.runtimeDurationMs
        : undefined),
    runtimeDurationMs: Date.now() - input.startedAt,
  });
}

function recordContextLayerErrorCounter(input: {
  error: ContextLayerError;
  requestId: string;
  refinementSessionId: string | undefined;
}): void {
  if (input.error.code === 'PROMPT_REFINER_TIMEOUT') {
    incrementContextLayerCounter('context_layer_prompt_refiner_timeout', {
      requestId: input.requestId,
      durationMs: input.error.runtimeDurationMs,
    });
  } else if (isPromptRefinerError(input.error.code)) {
    incrementContextLayerCounter('context_layer_prompt_refiner_failed', {
      requestId: input.requestId,
      errorCode: input.error.code,
    });
  } else if (input.error.code === 'REFINEMENT_SESSION_EXPIRED') {
    incrementContextLayerCounter('context_layer_refinement_session_expired', {
      requestId: input.requestId,
      sessionHash:
        input.refinementSessionId == null
          ? undefined
          : hashRefinementSessionId(input.refinementSessionId),
    });
  } else if (input.error.code === 'CODEX_SUBAGENT_TIMEOUT') {
    incrementContextLayerCounter('context_layer_subagent_timeout', {
      requestId: input.requestId,
      durationMs: input.error.runtimeDurationMs,
    });
  } else if (input.error.code === 'CODEX_SUBAGENT_PROFILE_MISSING') {
    incrementContextLayerCounter('context_layer_profile_missing', {
      requestId: input.requestId,
    });
  } else {
    incrementContextLayerCounter('context_layer_subagent_failed', {
      requestId: input.requestId,
      errorCode: input.error.code,
    });
  }
}

function resolveRefinementState(input: {
  input: ContextLayerInput;
  workspacePath: string;
  model: ResolvedContextLayerModel;
  requestId: string;
}): RefinementState {
  const maxFiles = DEFAULT_MAX_FILES;
  const maxSearchCalls = input.input.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS;
  const focus = (input.input.focus ?? DEFAULT_FOCUS) as ContextLayerFocus;

  if (input.input.refinementSession == null) {
    return {
      originalQuery: input.input.query,
      focus,
      maxFiles,
      maxSearchCalls,
      model: input.model,
    };
  }

  const existing = getRefinementSession(input.input.refinementSession);
  if (existing.workspacePath !== input.workspacePath) {
    throw new ContextLayerError(
      'REFINEMENT_SESSION_NOT_FOUND',
      `Refinement session ${existing.id} does not belong to this workspace.`,
    );
  }

  incrementContextLayerCounter('context_layer_refinement_session_resumed', {
    requestId: input.requestId,
    sessionHash: hashRefinementSessionId(existing.id),
  });

  if (input.input.agentAnswers == null) {
    return {
      originalQuery: existing.originalQuery,
      additionalCallerContext: additionalCallerContextForResume(
        existing,
        input.input.query,
      ),
      focus: existing.focus,
      maxFiles: existing.maxFiles,
      maxSearchCalls: existing.maxSearchCalls,
      model: existing.model,
      session: existing,
      previousRefinedQueryDraft: existing.refinedQueryDraft,
      previousQuestions: existing.questions,
    };
  }

  const updated = recordRefinementAttempt(existing, input.input.agentAnswers);
  return {
    originalQuery: updated.originalQuery,
    additionalCallerContext: additionalCallerContextForResume(
      updated,
      input.input.query,
    ),
    focus: updated.focus,
    maxFiles: updated.maxFiles,
    maxSearchCalls: updated.maxSearchCalls,
    model: updated.model,
    session: updated,
    previousRefinedQueryDraft: updated.refinedQueryDraft,
    previousQuestions: updated.questions,
    agentAnswers: input.input.agentAnswers,
  };
}

function upsertQuestionsSession(input: {
  state: RefinementState;
  workspacePath: string;
  refinement: Extract<PromptRefinerOutput, { status: 'needs_agent_answers' }>;
}): RefinementSession {
  if (input.state.session != null) {
    return updateRefinementSessionQuestions(input.state.session, {
      refinedQueryDraft: input.refinement.refinedQueryDraft,
      assumptions: input.refinement.assumptions,
      questions: input.refinement.questions,
    });
  }

  const session = createRefinementSession({
    workspacePath: input.workspacePath,
    originalQuery: input.state.originalQuery,
    additionalCallerContext: input.state.additionalCallerContext,
    focus: input.state.focus,
    maxFiles: input.state.maxFiles,
    maxSearchCalls: input.state.maxSearchCalls,
    model: input.state.model,
    refinedQueryDraft: input.refinement.refinedQueryDraft,
    assumptions: input.refinement.assumptions,
    questions: input.refinement.questions,
  });
  incrementContextLayerCounter('context_layer_refinement_session_created', {
    sessionHash: hashRefinementSessionId(session.id),
    questionCount: session.questions.length,
  });
  return session;
}

function additionalCallerContextForResume(
  session: RefinementSession,
  query: string,
): string | undefined {
  const trimmed = query.trim();
  if (!trimmed || trimmed === session.originalQuery.trim()) {
    return session.additionalCallerContext;
  }
  return trimmed;
}

async function prepareContextLayerSearch(input: {
  query: string;
  maxFiles: number;
  maxSearchCalls: number;
}): Promise<ContextLayerSearchPlan> {
  let handlerSearchCalls = 0;
  const warnings: string[] = [];

  const semanticCodeResults = await searchCodeForContextLayer({
    query: input.query,
    target: 'code',
    limit: Math.min(input.maxFiles * 3, 100),
  });
  handlerSearchCalls += 1;

  let docsResults: SearchResult[] = [];
  if (handlerSearchCalls < input.maxSearchCalls) {
    docsResults = await searchCodeForContextLayer({
      query: input.query,
      target: 'docs',
      limit: Math.min(input.maxFiles, 20),
    });
    handlerSearchCalls += 1;
  } else {
    warnings.push(
      'Docs pre-search skipped because maxSearchCalls budget was exhausted.',
    );
  }

  const exactBudget = Math.min(
    4,
    Math.max(0, input.maxSearchCalls - handlerSearchCalls - 1),
  );
  const exactPatterns = extractExactSearchPatterns({
    query: input.query,
    results: semanticCodeResults,
    maxPatterns: exactBudget,
  });
  const exactResults: SearchResult[] = [];

  for (const pattern of exactPatterns) {
    try {
      const results = await searchCodeForContextLayer({
        query: `Exact verification for ${pattern} related to: ${input.query}`,
        target: 'code',
        limit: Math.min(input.maxFiles * 2, 50),
        exact: {
          pattern,
          caseSensitive: true,
        },
        contextLines: 4,
      });
      handlerSearchCalls += 1;
      exactResults.push(...results);
    } catch (error) {
      handlerSearchCalls += 1;
      warnings.push(
        `Exact pre-search for "${pattern}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    codeResults: mergeSearchResults(semanticCodeResults, exactResults),
    docsResults,
    handlerSearchCalls,
    remainingSearchCalls: Math.max(
      0,
      input.maxSearchCalls - handlerSearchCalls,
    ),
    exactPatterns,
    warnings,
  };
}

async function searchCodeForContextLayer(input: {
  query: string;
  target: 'code' | 'docs';
  limit: number;
  exact?: { pattern: string; regex?: boolean; caseSensitive?: boolean };
  contextLines?: number;
}): Promise<Awaited<ReturnType<typeof searchCode>>['results']> {
  try {
    const response = await searchCode({
      query: input.query,
      target: input.target,
      limit: input.limit,
      exact: input.exact,
      contextLines: input.contextLines,
    });
    return response.results;
  } catch (error) {
    throw new ContextLayerError(
      'CODE_SEARCH_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function mergeSearchResults(...groups: SearchResult[][]): SearchResult[] {
  const bySymbol = new Map<string, SearchResult>();
  for (const result of groups.flat()) {
    const key =
      result.symbol.id ||
      `${result.symbol.relativePath}:${result.symbol.startLine}:${result.symbol.endLine}:${result.symbol.name}`;
    const existing = bySymbol.get(key);
    if (existing == null || result.score > existing.score) {
      bySymbol.set(key, result);
    }
  }

  return [...bySymbol.values()].sort((a, b) => b.score - a.score);
}

function extractExactSearchPatterns(input: {
  query: string;
  results: SearchResult[];
  maxPatterns: number;
}): string[] {
  if (input.maxPatterns <= 0) {
    return [];
  }

  const candidates: string[] = [];
  for (const match of input.query.matchAll(/`([^`\n]{2,120})`/g)) {
    candidates.push(match[1] ?? '');
  }
  for (const match of input.query.matchAll(
    /\b[A-Za-z_$][A-Za-z0-9_$./:-]{3,}\b/g,
  )) {
    candidates.push(match[0]);
  }
  for (const result of input.results.slice(0, 12)) {
    candidates.push(result.symbol.name);
    if (result.symbol.parentSymbol != null) {
      candidates.push(result.symbol.parentSymbol);
    }
  }

  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeExactPattern(candidate);
    if (!isUsefulExactPattern(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    patterns.push(normalized);
    if (patterns.length >= input.maxPatterns) {
      break;
    }
  }
  return patterns;
}

function normalizeExactPattern(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
}

function isUsefulExactPattern(pattern: string): boolean {
  if (pattern.length < 4 || pattern.length > 120) {
    return false;
  }
  if (COMMON_EXACT_PATTERN_STOPWORDS.has(pattern.toLowerCase())) {
    return false;
  }
  return /[A-Z0-9_$./:-]/.test(pattern);
}

const COMMON_EXACT_PATTERN_STOPWORDS = new Set([
  'architecture',
  'artifact',
  'artifacts',
  'branch',
  'calls',
  'code',
  'context',
  'dedupe',
  'deduplication',
  'debugging',
  'file',
  'files',
  'focus',
  'implementation',
  'ingestion',
  'query',
  'review',
  'runtime',
  'search',
  'storage',
]);

function normalizeContextLayerError(error: unknown): ContextLayerError {
  if (error instanceof ContextLayerError) {
    return error;
  }

  return new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    error instanceof Error ? error.message : String(error),
  );
}

function isPromptRefinerError(code: ContextLayerErrorCode): boolean {
  return (
    code === 'PROMPT_REFINER_FAILED' ||
    code === 'PROMPT_REFINER_EMPTY_OUTPUT' ||
    code === 'PROMPT_REFINER_MALFORMED_OUTPUT' ||
    code === 'PROMPT_REFINER_PROFILE_INVALID'
  );
}

function isPromptRefinerRuntimeError(code: ContextLayerErrorCode): boolean {
  return code === 'PROMPT_REFINER_TIMEOUT' || isPromptRefinerError(code);
}

function isResearchRuntimeError(code: ContextLayerErrorCode): boolean {
  return (
    code === 'CODEX_SUBAGENT_TIMEOUT' ||
    code === 'CODEX_SUBAGENT_FAILED' ||
    code === 'CODEX_SUBAGENT_EMPTY_OUTPUT' ||
    code === 'CODEX_SUBAGENT_OUTPUT_TOO_LARGE' ||
    code === 'CODE_SEARCH_UNAVAILABLE'
  );
}

export function defaultContextLayerToolTimeoutSec(): number {
  const fanoutConcurrency = resolveContextLayerFanoutConcurrency();
  const fanoutBatches = Math.ceil(DEFAULT_MAX_FILES / fanoutConcurrency);
  return (
    Math.ceil(resolvePromptRefinerTimeoutMs() / 1000) +
    fanoutBatches * Math.ceil(resolveContextLayerFileTimeoutMs() / 1000) +
    Math.ceil(resolveContextLayerTimeoutMs() / 1000) +
    DEFAULT_CONTEXT_LAYER_TOOL_TIMEOUT_BUFFER_SEC
  );
}
