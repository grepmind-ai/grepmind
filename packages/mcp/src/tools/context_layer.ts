import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensureMcpRuntimePrepared } from '../runtime-context.js';
import {
  DEFAULT_CONTEXT_LAYER_TIMEOUT_MS,
  runCodexSubagent,
  resolveContextLayerMaxOutputBytes,
  resolveContextLayerTimeoutMs,
} from './codex-subagent-runner.js';
import { ContextLayerError } from './context-layer-errors.js';
import type { ContextLayerErrorCode } from './context-layer-errors.js';
import {
  DEFAULT_CONTEXT_LAYER_CODEX_MODEL,
  DEFAULT_CONTEXT_LAYER_CODEX_SPEED,
  DEFAULT_CONTEXT_LAYER_CODEX_THINKING,
  resolveContextLayerModel,
  type ContextLayerRuntimeProvider,
  type ContextLayerSpeed,
  type ContextLayerThinking,
} from './context-layer-model-config.js';
import {
  hashWorkspacePath,
  incrementContextLayerCounter,
} from './context-layer-observability.js';
import {
  buildContextLayerPrompt,
  type ContextLayerFocus,
} from './context-layer-prompt.js';

export const DEFAULT_MAX_FILES = 30;
export const DEFAULT_MAX_SEARCH_CALLS = 8;
export const DEFAULT_FOCUS = 'implementation';

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
    maxFiles: z.number().int().min(1).max(80).optional(),
    maxSearchCalls: z.number().int().min(1).max(20).optional(),
    focus: z
      .enum(['implementation', 'debugging', 'architecture', 'review'])
      .optional(),
  })
  .strict();

export type ContextLayerInput = z.infer<typeof contextLayerSchema>;

interface ContextLayerSuccessResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  _meta: {
    model_provider: ContextLayerRuntimeProvider;
    model_name: string;
    model_thinking: ContextLayerThinking;
    model_speed: ContextLayerSpeed;
    max_search_calls: number;
    context_pack_path?: string;
    runtime_duration_ms: number;
    truncated: boolean;
    timeout: boolean;
  };
}

interface ContextLayerErrorResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  _meta: {
    error_code: ContextLayerErrorCode;
    model_provider?: ContextLayerRuntimeProvider;
    model_name?: string;
    model_thinking?: ContextLayerThinking;
    model_speed?: ContextLayerSpeed;
    max_search_calls?: number;
    runtime_duration_ms?: number;
    truncated: false;
    timeout: boolean;
  };
}

export async function contextLayerTool(
  input: ContextLayerInput,
): Promise<ContextLayerSuccessResult | ContextLayerErrorResult> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const maxSearchCalls = input.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS;
  let model: ReturnType<typeof resolveContextLayerModel> | undefined;

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

    model = resolveContextLayerModel(input.model);
    if (model.provider === 'claude') {
      throw new ContextLayerError(
        'CLAUDE_RUNTIME_NOT_IMPLEMENTED',
        'Claude context_layer runtime is not implemented yet. Use provider=codex.',
      );
    }

    const workspaceContext = await ensureMcpRuntimePrepared();
    const timeoutMs = resolveContextLayerTimeoutMs();
    const maxOutputBytes = resolveContextLayerMaxOutputBytes();
    const prompt = buildContextLayerPrompt({
      workspacePath: workspaceContext.workspacePath,
      query: input.query,
      maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES,
      maxSearchCalls,
      focus: (input.focus ?? DEFAULT_FOCUS) as ContextLayerFocus,
    });

    incrementContextLayerCounter('context_layer_subagent_started', {
      requestId,
      workspaceHash: hashWorkspacePath(workspaceContext.workspacePath),
      maxSearchCalls,
      timeoutMs,
    });
    const result = await runCodexSubagent({
      workspacePath: workspaceContext.workspacePath,
      dataDir: workspaceContext.dataDir,
      prompt,
      modelName: model.name,
      modelSpeed: model.speed,
      modelThinking: model.thinking,
      timeoutMs,
      maxOutputBytes,
    });

    if (result.truncated) {
      incrementContextLayerCounter('context_layer_output_truncated', {
        requestId,
        durationMs: result.runtimeDurationMs,
      });
    }
    incrementContextLayerCounter('context_layer_subagent_completed', {
      requestId,
      durationMs: result.runtimeDurationMs,
    });

    return {
      content: [{ type: 'text', text: result.contextPackMarkdown }],
      _meta: {
        model_provider: model.provider,
        model_name: model.name,
        model_thinking: model.thinking,
        model_speed: model.speed,
        max_search_calls: maxSearchCalls,
        context_pack_path: result.contextPackPath,
        runtime_duration_ms: result.runtimeDurationMs,
        truncated: result.truncated,
        timeout: result.timeout,
      },
    };
  } catch (error) {
    const normalized = normalizeContextLayerError(error);
    if (normalized.code === 'CODEX_SUBAGENT_TIMEOUT') {
      incrementContextLayerCounter('context_layer_subagent_timeout', {
        requestId,
        durationMs: normalized.runtimeDurationMs,
      });
    } else if (normalized.code === 'CODEX_SUBAGENT_PROFILE_MISSING') {
      incrementContextLayerCounter('context_layer_profile_missing', {
        requestId,
      });
    } else {
      incrementContextLayerCounter('context_layer_subagent_failed', {
        requestId,
        errorCode: normalized.code,
      });
    }

    return toErrorResult(normalized, {
      model: model ?? input.model,
      maxSearchCalls,
      runtimeDurationMs: normalized.runtimeDurationMs ?? Date.now() - startedAt,
    });
  }
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

function toErrorResult(
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
    runtimeDurationMs: number;
  },
): ContextLayerErrorResult {
  return {
    content: [
      {
        type: 'text',
        text: `Error: Grepmind context_layer subagent failed: ${error.message}`,
      },
    ],
    isError: true,
    _meta: {
      error_code: error.code,
      model_provider: context.model?.provider,
      model_name: context.model?.name ?? DEFAULT_CONTEXT_LAYER_CODEX_MODEL,
      model_thinking:
        context.model?.thinking ?? DEFAULT_CONTEXT_LAYER_CODEX_THINKING,
      model_speed: context.model?.speed ?? DEFAULT_CONTEXT_LAYER_CODEX_SPEED,
      max_search_calls: context.maxSearchCalls,
      runtime_duration_ms: context.runtimeDurationMs,
      truncated: false,
      timeout: error.timeout,
    },
  };
}

export function defaultContextLayerToolTimeoutSec(): number {
  return Math.ceil(DEFAULT_CONTEXT_LAYER_TIMEOUT_MS / 1000) + 30;
}
