export type ContextLayerRuntimeProvider = 'codex';
export type ContextLayerThinking = 'low' | 'medium';

export interface ResolvedContextLayerModel {
  provider: ContextLayerRuntimeProvider;
  name: string;
  thinking: ContextLayerThinking;
}

export const DEFAULT_CONTEXT_LAYER_MODEL_PROVIDER = 'codex';
export const DEFAULT_CONTEXT_LAYER_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CONTEXT_LAYER_CODEX_THINKING = 'low';
export const CONTEXT_LAYER_PROMPT_REFINER_THINKING = 'medium';
export const CONTEXT_LAYER_FILE_SUMMARY_THINKING = 'low';
export const CONTEXT_LAYER_AGGREGATION_THINKING = 'low';
export const CONTEXT_LAYER_POLISH_THINKING = 'medium';
export const CONTEXT_LAYER_RESEARCH_THINKING = 'medium';

export const CODEX_REASONING_EFFORT_BY_THINKING = {
  low: 'low',
  medium: 'medium',
} as const satisfies Record<ContextLayerThinking, string>;

export function resolveContextLayerModel(): ResolvedContextLayerModel {
  return {
    provider: DEFAULT_CONTEXT_LAYER_MODEL_PROVIDER,
    name: DEFAULT_CONTEXT_LAYER_CODEX_MODEL,
    thinking: DEFAULT_CONTEXT_LAYER_CODEX_THINKING,
  };
}

export function toCodexReasoningEffort(thinking: ContextLayerThinking): string {
  return CODEX_REASONING_EFFORT_BY_THINKING[thinking];
}
