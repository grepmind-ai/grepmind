export type ContextLayerErrorCode =
  | 'CODEX_CLI_NOT_FOUND'
  | 'CLAUDE_RUNTIME_NOT_IMPLEMENTED'
  | 'CODEX_SUBAGENT_PROFILE_MISSING'
  | 'CODEX_SUBAGENT_TIMEOUT'
  | 'CODEX_SUBAGENT_FAILED'
  | 'CODEX_SUBAGENT_EMPTY_OUTPUT'
  | 'CODEX_SUBAGENT_OUTPUT_TOO_LARGE'
  | 'CODE_SEARCH_UNAVAILABLE'
  | 'CONTEXT_LAYER_RECURSION_BLOCKED'
  | 'PROMPT_REFINER_TIMEOUT'
  | 'PROMPT_REFINER_FAILED'
  | 'PROMPT_REFINER_EMPTY_OUTPUT'
  | 'PROMPT_REFINER_MALFORMED_OUTPUT'
  | 'PROMPT_REFINER_PROFILE_INVALID'
  | 'REFINEMENT_SESSION_REQUIRED'
  | 'REFINEMENT_SESSION_NOT_FOUND'
  | 'REFINEMENT_SESSION_EXPIRED'
  | 'REFINEMENT_SESSION_ANSWER_REQUIRED'
  | 'REFINEMENT_SESSION_UNKNOWN_QUESTION'
  | 'REFINEMENT_SESSION_ATTEMPTS_EXCEEDED';

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
