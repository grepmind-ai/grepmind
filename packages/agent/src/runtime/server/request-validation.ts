import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRpcMethod,
  type AgentRpcMethodMap,
  type SearchExactQuery,
  type SearchTarget,
} from '../rpc/protocol.js';
import { AgentRpcRequestError } from './rpc-errors.js';

const MAX_EXACT_PATTERN_LENGTH = 500;
const MAX_EXACT_PATTERN_COUNT = 20;
const MAX_GLOB_COUNT = 20;
const MAX_GLOB_LENGTH = 200;
const MAX_CONTEXT_LINES = 10;

export function validateRequestId(requestId: unknown): void {
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: 'id must be a non-empty string',
      retryable: false,
    });
  }
}

export function validateProtocolVersion(protocolVersion: unknown): void {
  if (protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) {
    throw new AgentRpcRequestError({
      code: 'PROTOCOL_MISMATCH',
      message: `Protocol version mismatch: runtime=${AGENT_RUNTIME_PROTOCOL_VERSION}, client=${protocolVersion}`,
      retryable: false,
    });
  }
}

export function validateMethod(method: unknown): AgentRpcMethod {
  const methods: AgentRpcMethod[] = [
    'ping',
    'status',
    'registerProject',
    'listProjects',
    'syncProject',
    'unbindProject',
    'cleanProject',
    'searchHead',
    'shutdown',
  ];
  if (!methods.includes(method as AgentRpcMethod)) {
    throw new AgentRpcRequestError({
      code: 'UNKNOWN_METHOD',
      message: `Unknown RPC method: ${method}`,
      retryable: false,
    });
  }

  return method as AgentRpcMethod;
}

export function normalizeRequestTimeoutMs(
  timeoutMs: unknown,
): number | undefined {
  if (timeoutMs == null) {
    return undefined;
  }
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: 'timeoutMs must be a positive integer',
      retryable: false,
    });
  }

  return timeoutMs;
}

export function validateNoParams(
  params: unknown,
  method: AgentRpcMethod,
): void {
  if (params == null) {
    return;
  }
  const record = requireRecord(params, `${method}.params`);
  if (Object.keys(record).length > 0) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${method} does not accept params`,
      retryable: false,
    });
  }
}

export function normalizeStatusParams(
  params: unknown,
): AgentRpcMethodMap['status']['params'] {
  const record = params == null ? {} : requireRecord(params, 'status.params');

  return {
    bindingId: optionalPositiveInteger(record.bindingId, 'bindingId'),
    branch: optionalNonEmptyString(record.branch, 'branch'),
    commitSha: optionalNonEmptyString(record.commitSha, 'commitSha'),
    limit: optionalPositiveInteger(record.limit, 'limit'),
  };
}

export function normalizeRegisterProjectParams(
  params: unknown,
): AgentRpcMethodMap['registerProject']['params'] {
  const record = requireRecord(params, 'registerProject.params');

  return {
    remoteUrl: requiredNonEmptyString(record.remoteUrl, 'remoteUrl'),
    repoFullName: optionalNonEmptyString(record.repoFullName, 'repoFullName'),
    defaultBranch: optionalNonEmptyString(
      record.defaultBranch,
      'defaultBranch',
    ),
    displayName: requiredNonEmptyString(record.displayName, 'displayName'),
    workspacePath: requiredNonEmptyString(
      record.workspacePath,
      'workspacePath',
    ),
    workspaceFingerprint: requiredNonEmptyString(
      record.workspaceFingerprint,
      'workspaceFingerprint',
    ),
    preferredActiveBranch: optionalNonEmptyString(
      record.preferredActiveBranch,
      'preferredActiveBranch',
    ),
    idempotencyKey: requiredNonEmptyString(
      record.idempotencyKey,
      'idempotencyKey',
    ),
  };
}

export function normalizeSyncProjectParams(
  params: unknown,
): AgentRpcMethodMap['syncProject']['params'] {
  const record = requireRecord(params, 'syncProject.params');

  return {
    bindingId: optionalPositiveInteger(record.bindingId, 'bindingId'),
    targets: optionalSearchTargets(record.targets, 'targets'),
    idempotencyKey: requiredNonEmptyString(
      record.idempotencyKey,
      'idempotencyKey',
    ),
  };
}

export function normalizeUnbindProjectParams(
  params: unknown,
): AgentRpcMethodMap['unbindProject']['params'] {
  const record = requireRecord(params, 'unbindProject.params');

  return {
    bindingId: requiredPositiveInteger(record.bindingId, 'bindingId'),
    idempotencyKey: requiredNonEmptyString(
      record.idempotencyKey,
      'idempotencyKey',
    ),
  };
}

export function normalizeCleanProjectParams(
  params: unknown,
): AgentRpcMethodMap['cleanProject']['params'] {
  const record = requireRecord(params, 'cleanProject.params');

  return {
    bindingId: requiredPositiveInteger(record.bindingId, 'bindingId'),
    idempotencyKey: requiredNonEmptyString(
      record.idempotencyKey,
      'idempotencyKey',
    ),
  };
}

export function normalizeSearchHeadParams(
  params: unknown,
): AgentRpcMethodMap['searchHead']['params'] {
  const record = requireRecord(params, 'searchHead.params');

  return {
    bindingId: optionalPositiveInteger(record.bindingId, 'bindingId'),
    workspacePath: optionalNonEmptyString(
      record.workspacePath,
      'workspacePath',
    ),
    query: requiredNonEmptyString(record.query, 'query'),
    target: optionalSearchTarget(record.target, 'target'),
    limit: optionalPositiveInteger(record.limit, 'limit'),
    threshold: optionalThreshold(record.threshold, 'threshold'),
    rerank: optionalBoolean(record.rerank, 'rerank'),
    tags: optionalStringArray(record.tags, 'tags'),
    exact: optionalSearchExactQuery(record.exact, 'exact'),
    path: optionalNonEmptyString(record.path, 'path'),
    globs: optionalLimitedStringArray(
      record.globs,
      'globs',
      MAX_GLOB_COUNT,
      MAX_GLOB_LENGTH,
    ),
    contextLines: optionalContextLines(record.contextLines, 'contextLines'),
  };
}

export function normalizeShutdownParams(
  params: unknown,
): AgentRpcMethodMap['shutdown']['params'] {
  const record = requireRecord(params, 'shutdown.params');

  return {
    idempotencyKey: requiredNonEmptyString(
      record.idempotencyKey,
      'idempotencyKey',
    ),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be an object`,
      retryable: false,
    });
  }

  return value as Record<string, unknown>;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  const normalized = optionalNonEmptyString(value, label);
  if (normalized == null) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a non-empty string`,
      retryable: false,
    });
  }

  return normalized;
}

function optionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a string`,
      retryable: false,
    });
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a non-empty string`,
      retryable: false,
    });
  }

  return normalized;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const normalized = optionalPositiveInteger(value, label);
  if (normalized == null) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a positive integer`,
      retryable: false,
    });
  }

  return normalized;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a positive integer`,
      retryable: false,
    });
  }

  return value;
}

function optionalThreshold(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be between 0 and 1`,
      retryable: false,
    });
  }

  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a boolean`,
      retryable: false,
    });
  }

  return value;
}

function optionalContextLines(
  value: unknown,
  label: string,
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_CONTEXT_LINES
  ) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be an integer between 0 and ${MAX_CONTEXT_LINES}`,
      retryable: false,
    });
  }

  return value;
}

function optionalSearchTarget(
  value: unknown,
  label: string,
): SearchTarget | undefined {
  if (value == null) {
    return undefined;
  }
  if (value !== 'code' && value !== 'docs') {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be code or docs`,
      retryable: false,
    });
  }

  return value;
}

function optionalSearchTargets(
  value: unknown,
  label: string,
): SearchTarget[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be an array`,
      retryable: false,
    });
  }

  return value.map((entry, index) => {
    const target = optionalSearchTarget(entry, `${label}[${index}]`);
    if (target == null) {
      throw new AgentRpcRequestError({
        code: 'INVALID_REQUEST',
        message: `${label}[${index}] must be code or docs`,
        retryable: false,
      });
    }

    return target;
  });
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be an array`,
      retryable: false,
    });
  }

  const normalized = value.map((entry, index) =>
    requiredNonEmptyString(entry, `${label}[${index}]`),
  );
  return [...new Set(normalized)];
}

function optionalLimitedStringArray(
  value: unknown,
  label: string,
  maxCount: number,
  maxLength: number,
): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be an array`,
      retryable: false,
    });
  }
  if (value.length > maxCount) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must contain at most ${maxCount} entries`,
      retryable: false,
    });
  }

  const normalized = value.map((entry, index) => {
    const item = requiredNonEmptyString(entry, `${label}[${index}]`);
    if (item.length > maxLength) {
      throw new AgentRpcRequestError({
        code: 'INVALID_REQUEST',
        message: `${label}[${index}] must be at most ${maxLength} characters`,
        retryable: false,
      });
    }

    return item;
  });

  return [...new Set(normalized)];
}

function optionalSearchExactQuery(
  value: unknown,
  label: string,
): SearchExactQuery | undefined {
  if (value == null) {
    return undefined;
  }

  const record = requireRecord(value, label);
  const normalizedPatterns = normalizeExactPatternValue(
    record.pattern,
    `${label}.pattern`,
  );
  if (normalizedPatterns.length === 0) {
    return undefined;
  }
  if (normalizedPatterns.length > MAX_EXACT_PATTERN_COUNT) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label}.pattern must contain at most ${MAX_EXACT_PATTERN_COUNT} entries`,
      retryable: false,
    });
  }

  return {
    pattern:
      normalizedPatterns.length === 1
        ? normalizedPatterns[0]
        : normalizedPatterns,
    regex: optionalBoolean(record.regex, `${label}.regex`),
    caseSensitive: optionalBoolean(
      record.caseSensitive,
      `${label}.caseSensitive`,
    ),
  };
}

function normalizeExactPatternValue(value: unknown, label: string): string[] {
  if (value == null) {
    return [];
  }
  if (typeof value === 'string') {
    return validateExactPatternEntries([value], label);
  }
  if (!Array.isArray(value)) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must be a string or an array of strings`,
      retryable: false,
    });
  }

  return validateExactPatternEntries(value, label);
}

function validateExactPatternEntries(value: unknown[], label: string): string[] {
  if (value.length > MAX_EXACT_PATTERN_COUNT) {
    throw new AgentRpcRequestError({
      code: 'INVALID_REQUEST',
      message: `${label} must contain at most ${MAX_EXACT_PATTERN_COUNT} entries`,
      retryable: false,
    });
  }

  const normalized = value.map((entry, index) => {
    const item = requiredNonEmptyString(entry, `${label}[${index}]`);
    if (item.length > MAX_EXACT_PATTERN_LENGTH) {
      throw new AgentRpcRequestError({
        code: 'INVALID_REQUEST',
        message: `${label}[${index}] must be at most ${MAX_EXACT_PATTERN_LENGTH} characters`,
        retryable: false,
      });
    }

    return item;
  });

  return [...new Set(normalized)];
}
