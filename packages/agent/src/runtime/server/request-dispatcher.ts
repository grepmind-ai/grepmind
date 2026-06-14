import { AgentBackendClientError } from '../../backend/agent-backend-client.js';
import { AgentRealtimeSearchError } from '../../backend/agent-backend-realtime-client.js';
import { AgentCommandExecutor } from '../../commands/agent-command-executor.js';
import {
  SearchHeadNotReadyError,
  SearchHeadService,
} from '../../services/search-head-service.js';
import {
  AgentRpcIdempotencyConflictError,
  AgentRpcIdempotencyStore,
  type StoredIdempotentRecord,
} from '../rpc/idempotency-store.js';
import {
  type AgentRpcError,
  type AgentRpcMethod,
  type AgentRpcMethodMap,
  type AgentRpcRequest,
  type AgentRuntimeMeta,
  type AgentRuntimePingResult,
  isMutatingRpcMethod,
} from '../rpc/protocol.js';
import { SingleWriterQueue } from '../single-writer-queue.js';
import { AgentRpcRequestError } from './rpc-errors.js';
import {
  normalizeCleanProjectParams,
  normalizeRegisterProjectParams,
  normalizeRequestTimeoutMs,
  normalizeSearchHeadParams,
  normalizeShutdownParams,
  normalizeStatusParams,
  normalizeSyncProjectParams,
  normalizeUnbindProjectParams,
  validateMethod,
  validateNoParams,
  validateProtocolVersion,
  validateRequestId,
} from './request-validation.js';

export interface AgentRuntimeRequestDispatcherOptions {
  dataDir: string;
  queue: SingleWriterQueue;
  getMeta(): AgentRuntimeMeta | null;
  isStopping(): boolean;
  getCommandExecutor(): AgentCommandExecutor | null;
  getSearchHeadService(): SearchHeadService | null;
  getIdempotencyStore(): AgentRpcIdempotencyStore | null;
  onShutdownAccepted(): void;
}

export class AgentRuntimeRequestDispatcher {
  constructor(private readonly options: AgentRuntimeRequestDispatcherOptions) {}

  async dispatch<TMethod extends AgentRpcMethod>(
    request: AgentRpcRequest<TMethod>,
  ): Promise<AgentRpcMethodMap[TMethod]['result']> {
    const method = validateMethod(request.method);
    validateRequestId(request.id);
    validateProtocolVersion(request.protocolVersion);
    const timeoutMs = normalizeRequestTimeoutMs(request.timeoutMs);
    const deadlineMs = timeoutMs == null ? undefined : Date.now() + timeoutMs;

    if (method !== 'ping') {
      this.requireAuthorizedToken(request.token);
    }
    if (this.options.isStopping() && method !== 'ping') {
      throw new AgentRpcRequestError({
        code: 'SHUTTING_DOWN',
        message: 'Agent runtime is shutting down',
        retryable: true,
      });
    }

    switch (method) {
      case 'ping':
        return this.getPingResult() as AgentRpcMethodMap[TMethod]['result'];
      case 'status': {
        const params = normalizeStatusParams(request.params);
        const result = await this.requireCommandExecutor().status(params);
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'listProjects': {
        validateNoParams(request.params, 'listProjects');
        const result = await this.requireCommandExecutor().listProjects();
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'registerProject': {
        const params = normalizeRegisterProjectParams(request.params);
        const result = await this.enqueue(
          () =>
            this.executeIdempotent(
              'registerProject',
              params.idempotencyKey,
              params,
              async () =>
                this.requireCommandExecutor().registerProject({
                  remoteUrl: params.remoteUrl,
                  repoFullName: params.repoFullName,
                  defaultBranch: params.defaultBranch,
                  displayName: params.displayName,
                  workspacePath: params.workspacePath,
                  workspaceFingerprint: params.workspaceFingerprint,
                  preferredActiveBranch: params.preferredActiveBranch,
                }),
            ),
          deadlineMs,
        );
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'syncProject': {
        const params = normalizeSyncProjectParams(request.params);
        const result = await this.enqueue(
          () =>
            this.executeIdempotent(
              'syncProject',
              params.idempotencyKey,
              params,
              async () =>
                this.requireCommandExecutor().syncProject({
                  bindingId: params.bindingId,
                  targets: params.targets,
                }),
            ),
          deadlineMs,
        );
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'unbindProject': {
        const params = normalizeUnbindProjectParams(request.params);
        const result = await this.enqueue(async () => {
          await this.executeIdempotent(
            'unbindProject',
            params.idempotencyKey,
            params,
            async () => {
              await this.requireCommandExecutor().unbindProject(
                params.bindingId,
              );
              return {};
            },
          );
          return {};
        }, deadlineMs);
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'cleanProject': {
        const params = normalizeCleanProjectParams(request.params);
        const result = await this.enqueue(
          () =>
            this.executeIdempotent(
              'cleanProject',
              params.idempotencyKey,
              params,
              async () =>
                this.requireCommandExecutor().cleanProject(params.bindingId),
            ),
          deadlineMs,
        );
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'searchHead': {
        const params = normalizeSearchHeadParams(request.params);
        const result = await this.requireSearchHeadService().searchByLocalHead(
          params,
          { timeoutMs },
        );
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'shutdown': {
        const params = normalizeShutdownParams(request.params);
        const result = await this.enqueue(async () => {
          const result = await this.executeIdempotent(
            'shutdown',
            params.idempotencyKey,
            params,
            async () => ({
              accepted: true as const,
            }),
          );
          this.options.onShutdownAccepted();
          return result;
        }, deadlineMs);
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      default:
        throw new AgentRpcRequestError({
          code: 'UNKNOWN_METHOD',
          message: `Unknown RPC method: ${String(method)}`,
          retryable: false,
        });
    }
  }

  private async executeIdempotent<TResult>(
    method: AgentRpcMethod,
    idempotencyKey: string | undefined,
    params: unknown,
    task: () => Promise<TResult>,
  ): Promise<TResult> {
    if (!isMutatingRpcMethod(method)) {
      return task();
    }
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new AgentRpcRequestError({
        code: 'INVALID_REQUEST',
        message: `${method} requires idempotencyKey`,
        retryable: false,
      });
    }

    const store = this.requireIdempotencyStore();
    const requestFingerprint = store.createRequestFingerprint(params);
    const existing = await store.read<TResult>(
      method,
      idempotencyKey,
      requestFingerprint,
    );
    if (existing) {
      return fromStoredIdempotentRecord(existing);
    }

    try {
      const result = await task();
      await store.writeSuccess(
        method,
        idempotencyKey,
        requestFingerprint,
        result,
      );
      return result;
    } catch (error) {
      const rpcError = toRpcError(error);
      await store.writeError(
        method,
        idempotencyKey,
        requestFingerprint,
        rpcError,
      );
      throw new AgentRpcRequestError(rpcError);
    }
  }

  private enqueue<T>(
    task: () => Promise<T>,
    deadlineMs: number | undefined,
  ): Promise<T> {
    return this.options.queue.enqueue(async () => {
      if (deadlineMs != null && Date.now() >= deadlineMs) {
        throw new AgentRpcRequestError({
          code: 'REQUEST_EXPIRED',
          message: 'RPC request expired before it started executing',
          retryable: true,
        });
      }

      return task();
    });
  }

  private getPingResult(): AgentRuntimePingResult {
    const meta = this.requireMeta();
    return {
      protocolVersion: meta.protocolVersion,
      instanceId: meta.instanceId,
      startedAt: meta.startedAt,
      pid: meta.pid,
      dataDir: this.options.dataDir,
      runtimeLogPath: meta.runtimeLogPath,
    };
  }

  private requireAuthorizedToken(token: string | undefined): void {
    const meta = this.requireMeta();
    if (!token || token !== meta.token) {
      throw new AgentRpcRequestError({
        code: 'UNAUTHORIZED',
        message: 'Invalid runtime handshake token',
        retryable: false,
      });
    }
  }

  private requireMeta(): AgentRuntimeMeta {
    const meta = this.options.getMeta();
    if (!meta) {
      throw new AgentRpcRequestError({
        code: 'RUNTIME_NOT_READY',
        message: 'Agent runtime is not ready',
        retryable: true,
      });
    }

    return meta;
  }

  private requireCommandExecutor(): AgentCommandExecutor {
    const commandExecutor = this.options.getCommandExecutor();
    if (!commandExecutor) {
      throw new AgentRpcRequestError({
        code: 'RUNTIME_NOT_READY',
        message: 'Agent runtime command executor is not initialized',
        retryable: true,
      });
    }

    return commandExecutor;
  }

  private requireSearchHeadService(): SearchHeadService {
    const searchHeadService = this.options.getSearchHeadService();
    if (!searchHeadService) {
      throw new AgentRpcRequestError({
        code: 'RUNTIME_NOT_READY',
        message: 'Agent runtime search-head service is not initialized',
        retryable: true,
      });
    }

    return searchHeadService;
  }

  private requireIdempotencyStore(): AgentRpcIdempotencyStore {
    const idempotencyStore = this.options.getIdempotencyStore();
    if (!idempotencyStore) {
      throw new AgentRpcRequestError({
        code: 'RUNTIME_NOT_READY',
        message: 'Agent runtime idempotency store is not initialized',
        retryable: true,
      });
    }

    return idempotencyStore;
  }
}

function fromStoredIdempotentRecord<TResult>(
  record: StoredIdempotentRecord<TResult>,
): TResult {
  if (record.kind === 'success') {
    return record.result;
  }

  throw new AgentRpcRequestError(record.error);
}

export function toRpcError(error: unknown): AgentRpcError {
  if (error instanceof AgentRpcRequestError) {
    return error.rpcError;
  }
  if (error instanceof AgentRpcIdempotencyConflictError) {
    return {
      code: 'INVALID_REQUEST',
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof AgentBackendClientError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: {
        status: error.status,
        details: error.details,
      },
    };
  }
  if (error instanceof AgentRealtimeSearchError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error instanceof SearchHeadNotReadyError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      code: inferErrorCode(error),
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: 'INTERNAL',
    message: String(error),
    retryable: false,
  };
}

function inferErrorCode(error: Error): string {
  const message = error.message.toLowerCase();
  if (message.includes('not registered') || message.includes('not found')) {
    return 'NOT_FOUND';
  }
  if (message.includes('already exists')) {
    return 'ALREADY_EXISTS';
  }
  if (message.includes('required') || message.includes('must be')) {
    return 'INVALID_REQUEST';
  }

  return 'INTERNAL';
}
