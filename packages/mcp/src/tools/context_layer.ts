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
  CONTEXT_LAYER_PROMPT_REFINER_THINKING,
  CONTEXT_LAYER_RESEARCH_THINKING,
  resolveContextLayerModel,
  type ContextLayerThinking,
  type ResolvedContextLayerModel,
} from './context-layer-model-config.js';
import {
  hashRefinementSessionId,
  hashWorkspacePath,
  incrementContextLayerCounter,
} from './context-layer-observability.js';
import { type ContextLayerFocus } from './context-layer-types.js';
import { buildContextLayerResearchPrompt } from './context-layer-research-prompt.js';
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

export const DEFAULT_MAX_FILES = 30;
export const DEFAULT_MAX_SEARCH_CALLS = 8;
export const DEFAULT_FOCUS = 'implementation';
export const DEFAULT_CONTEXT_LAYER_TOOL_TIMEOUT_BUFFER_SEC = 30;

export const contextLayerSchema = z
  .object({
    query: z.string().min(1).describe('Task or code question to research'),
    maxSearchCalls: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Research subagent code_search budget.'),
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

interface ContextLayerIterationResult {
  contextPackMarkdown: string;
  contextPackPath?: string;
  truncated: boolean;
  timeout: false;
  runtimeDurationMs: number;
  fanoutRuntimeDurationMs: 0;
  aggregationRuntimeDurationMs: number;
  fanoutFileCount: 0;
  fanoutCompletedCount: 0;
  fanoutFailedCount: 0;
  handlerSearchCalls: number;
  remainingSearchCalls: number;
  exactPatterns: string[];
  searchWarnings: string[];
  iterations: number;
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

    model = resolveContextLayerModel();

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
      modelThinking: CONTEXT_LAYER_PROMPT_REFINER_THINKING,
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
    const result = await runContextLayerResearch({
      requestId,
      workspacePath: workspaceContext.workspacePath,
      query: refiner.output.refinedQuery,
      originalQuery: refinementState.originalQuery,
      refinerAssumptions: refiner.output.assumptions,
      focus: refinementState.focus,
      maxSearchCalls: refinementState.maxSearchCalls,
      modelName: refinementState.model.name,
      researchModelThinking: CONTEXT_LAYER_RESEARCH_THINKING,
      timeoutMs,
      maxOutputBytes,
    });
    researchRuntimeDurationMs = result.runtimeDurationMs;

    const aggregationSufficiency = parseSufficiency(result.contextPackMarkdown);

    if (result.truncated) {
      incrementContextLayerCounter('context_layer_output_truncated', {
        requestId,
        durationMs: result.runtimeDurationMs,
      });
    }
    return {
      content: [
        {
          type: 'text',
          text: appendContextLayerDebugLog(result.contextPackMarkdown, result),
        },
      ],
      _meta: {
        result_kind: 'context_pack',
        model_provider: refinementState.model.provider,
        model_name: refinementState.model.name,
        model_thinking: refinementState.model.thinking,
        prompt_refiner_model_thinking: CONTEXT_LAYER_PROMPT_REFINER_THINKING,
        research_model_thinking: CONTEXT_LAYER_RESEARCH_THINKING,
        file_summary_model_thinking: CONTEXT_LAYER_RESEARCH_THINKING,
        aggregation_model_thinking: CONTEXT_LAYER_RESEARCH_THINKING,
        polish_model_thinking: CONTEXT_LAYER_RESEARCH_THINKING,
        max_search_calls: refinementState.maxSearchCalls,
        handler_search_calls: result.handlerSearchCalls,
        remaining_search_calls: result.remainingSearchCalls,
        handler_exact_patterns: result.exactPatterns,
        handler_search_warnings: result.searchWarnings,
        context_layer_iterations: result.iterations,
        sufficient: aggregationSufficiency.sufficient,
        suggested_context_queries:
          aggregationSufficiency.suggestedContextQueries,
        context_pack_path: result.contextPackPath,
        prompt_refiner_runtime_duration_ms: refiner.runtimeDurationMs,
        research_runtime_duration_ms: researchRuntimeDurationMs,
        fanout_file_count: result.fanoutFileCount,
        fanout_completed_count: result.fanoutCompletedCount,
        fanout_failed_count: result.fanoutFailedCount,
        fanout_runtime_duration_ms: result.fanoutRuntimeDurationMs,
        aggregation_runtime_duration_ms: result.aggregationRuntimeDurationMs,
        polish_runtime_duration_ms: 0,
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
      model,
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
    polishRuntimeDurationMs: undefined,
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

async function runContextLayerResearch(input: {
  requestId: string;
  workspacePath: string;
  query: string;
  originalQuery?: string;
  refinerAssumptions?: string[];
  focus: ContextLayerFocus;
  maxSearchCalls: number;
  modelName: string;
  researchModelThinking: ContextLayerThinking;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ContextLayerIterationResult> {
  const iteration = 1;
  const researchPrompt = buildContextLayerResearchPrompt({
    workspacePath: input.workspacePath,
    query: input.query,
    originalQuery: input.originalQuery,
    refinerAssumptions: input.refinerAssumptions,
    focus: input.focus,
    maxSearchCalls: input.maxSearchCalls,
  });

  incrementContextLayerCounter('context_layer_subagent_started', {
    requestId: input.requestId,
    workspaceHash: hashWorkspacePath(input.workspacePath),
    maxSearchCalls: input.maxSearchCalls,
    timeoutMs: input.timeoutMs,
    iteration,
  });
  const result = await runCodexSubagent({
    workspacePath: input.workspacePath,
    prompt: researchPrompt,
    modelName: input.modelName,
    modelThinking: input.researchModelThinking,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  });

  incrementContextLayerCounter('context_layer_subagent_completed', {
    requestId: input.requestId,
    durationMs: result.runtimeDurationMs,
    iteration,
  });

  return {
    contextPackMarkdown: result.contextPackMarkdown,
    contextPackPath: result.contextPackPath,
    truncated: result.truncated,
    timeout: false,
    runtimeDurationMs: result.runtimeDurationMs,
    fanoutRuntimeDurationMs: 0,
    aggregationRuntimeDurationMs: result.runtimeDurationMs,
    fanoutFileCount: 0,
    fanoutCompletedCount: 0,
    fanoutFailedCount: 0,
    handlerSearchCalls: 0,
    remainingSearchCalls: input.maxSearchCalls,
    exactPatterns: [],
    searchWarnings: [],
    iterations: iteration,
  };
}

function parseSufficiency(contextPackMarkdown: string): {
  sufficient: boolean;
  suggestedContextQueries: string[];
} {
  const content = extractContextPackSection(
    contextPackMarkdown,
    '## Sufficiency',
  );
  const enoughMatch =
    /(^|\n)\s*-?\s*Enough to answer:\s*(yes|no)\b/im.exec(content);
  const suggestedBlockMatch =
    /(^|\n)\s*-?\s*Suggested next context queries:\s*([\s\S]*)$/im.exec(
      content,
    );
  const suggestedBlock = suggestedBlockMatch?.[2] ?? '';

  return {
    sufficient: enoughMatch?.[2]?.toLowerCase() === 'yes',
    suggestedContextQueries: extractSuggestedContextQueries(suggestedBlock),
  };
}

function appendContextLayerDebugLog(
  contextPackMarkdown: string,
  result: ContextLayerIterationResult,
): string {
  const debugLine =
    `- Debug log: iterations=${result.iterations}; ` +
    'research agents=1; ' +
    `fanout agents=${result.fanoutFileCount}; ` +
    'aggregation agents=0; ' +
    'polish agents=0; ' +
    'completed=1; ' +
    `failed=${result.fanoutFailedCount}.`;
  const codeContextHeading = '\n\n## Code Context';
  const index = contextPackMarkdown.indexOf(codeContextHeading);
  if (index < 0) {
    return `${contextPackMarkdown.trimEnd()}\n${debugLine}`;
  }

  return `${contextPackMarkdown.slice(0, index).trimEnd()}\n${debugLine}${contextPackMarkdown.slice(index)}`;
}

function extractContextPackSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return '';
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines.join('\n').trim();
}

function extractSuggestedContextQueries(block: string): string[] {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const queries: string[] = [];

  for (const line of lines) {
    const item = line
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    if (/^(None\.?|No(ne)?\.?)$/i.test(item)) {
      continue;
    }
    if (!item || item.includes(':') && queries.length > 0) {
      continue;
    }
    if (/^(Missing context|Stop reason):/i.test(item)) {
      continue;
    }
    queries.push(item);
    if (queries.length >= 3) {
      break;
    }
  }

  return queries;
}

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
  return (
    Math.ceil(resolvePromptRefinerTimeoutMs() / 1000) +
    Math.ceil(resolveContextLayerTimeoutMs() / 1000) +
    DEFAULT_CONTEXT_LAYER_TOOL_TIMEOUT_BUFFER_SEC
  );
}
