export type ContextLayerErrorCode =
  | 'CODEX_CLI_NOT_FOUND'
  | 'CLAUDE_RUNTIME_NOT_IMPLEMENTED'
  | 'CODEX_SUBAGENT_PROFILE_MISSING'
  | 'CODEX_SUBAGENT_TIMEOUT'
  | 'CODEX_SUBAGENT_FAILED'
  | 'CODEX_SUBAGENT_EMPTY_OUTPUT'
  | 'CODEX_SUBAGENT_OUTPUT_TOO_LARGE'
  | 'CODE_SEARCH_UNAVAILABLE'
  | 'CONTEXT_LAYER_RECURSION_BLOCKED';

export class ContextLayerError extends Error {
  readonly code: ContextLayerErrorCode;
  readonly timeout: boolean;
  readonly runtimeDurationMs?: number;

  constructor(
    code: ContextLayerErrorCode,
    message: string,
    options?: {
      timeout?: boolean;
      runtimeDurationMs?: number;
    },
  ) {
    super(message);
    this.name = 'ContextLayerError';
    this.code = code;
    this.timeout = options?.timeout ?? false;
    this.runtimeDurationMs = options?.runtimeDurationMs;
  }
}
