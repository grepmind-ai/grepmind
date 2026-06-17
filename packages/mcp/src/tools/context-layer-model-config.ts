import { ContextLayerError } from './context-layer-errors.js';

export type ContextLayerRuntimeProvider = 'codex' | 'claude';
export type ContextLayerThinking = 'low' | 'medium' | 'high';
export type ContextLayerSpeed = 'fast';

export interface ContextLayerModelInput {
  provider?: ContextLayerRuntimeProvider;
  name?: string;
  thinking?: ContextLayerThinking;
  speed?: ContextLayerSpeed;
}

export interface ResolvedContextLayerModel {
  provider: ContextLayerRuntimeProvider;
  name: string;
  thinking: ContextLayerThinking;
  speed: ContextLayerSpeed;
}

export const DEFAULT_CONTEXT_LAYER_MODEL_PROVIDER = 'codex';
export const DEFAULT_CONTEXT_LAYER_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CONTEXT_LAYER_CODEX_THINKING = 'low';
export const DEFAULT_CONTEXT_LAYER_CODEX_SPEED = 'fast';

export const CODEX_REASONING_EFFORT_BY_THINKING = {
  low: 'low',
  medium: 'medium',
  high: 'high',
} as const satisfies Record<ContextLayerThinking, string>;

export function resolveContextLayerModel(
  input: ContextLayerModelInput | undefined,
): ResolvedContextLayerModel {
  const provider =
    input?.provider ??
    readProviderEnv() ??
    DEFAULT_CONTEXT_LAYER_MODEL_PROVIDER;
  const thinking =
    input?.thinking ??
    readThinkingEnv() ??
    DEFAULT_CONTEXT_LAYER_CODEX_THINKING;
  const speed =
    input?.speed ?? readSpeedEnv() ?? DEFAULT_CONTEXT_LAYER_CODEX_SPEED;

  return {
    provider,
    name:
      input?.name ??
      readStringEnv('GREPMIND_CONTEXT_LAYER_CODEX_MODEL') ??
      DEFAULT_CONTEXT_LAYER_CODEX_MODEL,
    thinking,
    speed,
  };
}

export function toCodexReasoningEffort(thinking: ContextLayerThinking): string {
  return CODEX_REASONING_EFFORT_BY_THINKING[thinking];
}

function readProviderEnv(): ContextLayerRuntimeProvider | undefined {
  const raw = readStringEnv('GREPMIND_CONTEXT_LAYER_PROVIDER');
  if (raw == null) {
    return undefined;
  }
  if (raw === 'codex' || raw === 'claude') {
    return raw;
  }
  throw new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    'GREPMIND_CONTEXT_LAYER_PROVIDER must be "codex" or "claude".',
  );
}

function readThinkingEnv(): ContextLayerThinking | undefined {
  const raw = readStringEnv('GREPMIND_CONTEXT_LAYER_CODEX_THINKING');
  if (raw == null) {
    return undefined;
  }
  if (raw === 'low' || raw === 'medium' || raw === 'high') {
    return raw;
  }
  throw new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    'GREPMIND_CONTEXT_LAYER_CODEX_THINKING must be "low", "medium", or "high".',
  );
}

function readSpeedEnv(): ContextLayerSpeed | undefined {
  const raw = readStringEnv('GREPMIND_CONTEXT_LAYER_CODEX_SPEED');
  if (raw == null) {
    return undefined;
  }
  if (raw === 'fast') {
    return raw;
  }
  throw new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    'GREPMIND_CONTEXT_LAYER_CODEX_SPEED must be "fast".',
  );
}

function readStringEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw || undefined;
}
