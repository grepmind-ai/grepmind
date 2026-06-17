import { ContextLayerError } from './context-layer-errors.js';
import type { ContextLayerErrorCode } from './context-layer-errors.js';
import {
  DEFAULT_CONTEXT_LAYER_CODEX_MODEL,
  DEFAULT_CONTEXT_LAYER_CODEX_SPEED,
  DEFAULT_CONTEXT_LAYER_CODEX_THINKING,
  type ContextLayerRuntimeProvider,
  type ContextLayerSpeed,
  type ContextLayerThinking,
} from './context-layer-model-config.js';
import type { RefinementSession } from './context-layer-refinement-session.js';
import type { PromptRefinerQuestion } from './prompt-refiner-output.js';

export interface ContextLayerSuccessResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  _meta: {
    result_kind: 'context_pack';
    model_provider: ContextLayerRuntimeProvider;
    model_name: string;
    model_thinking: ContextLayerThinking;
    model_speed: ContextLayerSpeed;
    max_search_calls: number;
    handler_search_calls: number;
    remaining_search_calls: number;
    handler_exact_patterns: string[];
    handler_search_warnings: string[];
    context_pack_path?: string;
    prompt_refiner_runtime_duration_ms: number;
    research_runtime_duration_ms: number;
    fanout_file_count: number;
    fanout_completed_count: number;
    fanout_failed_count: number;
    fanout_runtime_duration_ms: number;
    aggregation_runtime_duration_ms: number;
    runtime_duration_ms: number;
    truncated: boolean;
    timeout: boolean;
  };
}

export interface ContextLayerAgentQuestionsResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  _meta: {
    result_kind: 'agent_questions';
    refinement_session: string;
    refined_query_draft: string;
    questions: PromptRefinerQuestion[];
    prompt_refiner_runtime_duration_ms: number;
    runtime_duration_ms: number;
    truncated: false;
    timeout: false;
  };
}

export interface ContextLayerErrorResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  _meta: {
    result_kind: 'error';
    error_code: ContextLayerErrorCode;
    refinement_session?: string;
    model_provider?: ContextLayerRuntimeProvider;
    model_name?: string;
    model_thinking?: ContextLayerThinking;
    model_speed?: ContextLayerSpeed;
    max_search_calls?: number;
    prompt_refiner_runtime_duration_ms?: number;
    research_runtime_duration_ms?: number;
    runtime_duration_ms: number;
    truncated: false;
    timeout: boolean;
  };
}

export type ContextLayerResult =
  | ContextLayerSuccessResult
  | ContextLayerAgentQuestionsResult
  | ContextLayerErrorResult;

export function toAgentQuestionsResult(input: {
  session: RefinementSession;
  refinerDurationMs: number;
  runtimeDurationMs: number;
}): ContextLayerAgentQuestionsResult {
  return {
    content: [
      {
        type: 'text',
        text: renderAgentQuestionsMarkdown(input.session),
      },
    ],
    _meta: {
      result_kind: 'agent_questions',
      refinement_session: input.session.id,
      refined_query_draft: input.session.refinedQueryDraft,
      questions: input.session.questions,
      prompt_refiner_runtime_duration_ms: input.refinerDurationMs,
      runtime_duration_ms: input.runtimeDurationMs,
      truncated: false,
      timeout: false,
    },
  };
}

export function toErrorResult(
  error: ContextLayerError,
  context: {
    model:
      | {
          provider?: ContextLayerRuntimeProvider;
          name?: string;
          thinking?: ContextLayerThinking;
          speed?: ContextLayerSpeed;
        }
      | undefined;
    maxSearchCalls: number;
    refinementSession: string | undefined;
    promptRefinerRuntimeDurationMs: number | undefined;
    researchRuntimeDurationMs: number | undefined;
    runtimeDurationMs: number;
  },
): ContextLayerErrorResult {
  return {
    content: [
      {
        type: 'text',
        text: `Error: Grepmind context_layer failed: ${error.message}`,
      },
    ],
    isError: true,
    _meta: {
      result_kind: 'error',
      error_code: error.code,
      refinement_session: context.refinementSession,
      model_provider: context.model?.provider,
      model_name: context.model?.name ?? DEFAULT_CONTEXT_LAYER_CODEX_MODEL,
      model_thinking:
        context.model?.thinking ?? DEFAULT_CONTEXT_LAYER_CODEX_THINKING,
      model_speed: context.model?.speed ?? DEFAULT_CONTEXT_LAYER_CODEX_SPEED,
      max_search_calls: context.maxSearchCalls,
      prompt_refiner_runtime_duration_ms:
        context.promptRefinerRuntimeDurationMs,
      research_runtime_duration_ms: context.researchRuntimeDurationMs,
      runtime_duration_ms: context.runtimeDurationMs,
      truncated: false,
      timeout: error.timeout,
    },
  };
}

function renderAgentQuestionsMarkdown(session: RefinementSession): string {
  return `# agent_questions

Refinement session: ${session.id}

## Refined Query Draft

${session.refinedQueryDraft}

## Questions For Calling Agent

  ${session.questions
    .map(
      (question, index) =>
        `${index + 1}. ${question.id}: ${question.question}
   Reason: ${question.reason}`,
    )
    .join('\n')}`;
}
