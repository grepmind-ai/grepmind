import { AgentBackendClientError } from '../../backend/agent-backend-client.js';
import { AgentCommandExecutor } from '../../commands/agent-command-executor.js';
import { SearchHeadService } from '../../services/search-head-service.js';
import { AgentRpcIdempotencyStore, type StoredIdempotentRecord } from '../rpc/idempotency-store.js';
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRpcError,
  type AgentRpcMethod,
  type AgentRpcMethodMap,
  type AgentRpcRequest,
  type AgentRuntimeMeta,
  type AgentRuntimePingResult,
  isMutatingRpcMethod,
} from '../rpc/protocol.js';
import { SingleWriterQueue } from '../single-writer-queue.js';

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

export class AgentRpcRequestError extends Error {
  constructor(readonly rpcError: AgentRpcError) {
    super(rpcError.message);
    this.name = 'AgentRpcRequestError';
  }
}

export class AgentRuntimeRequestDispatcher {
  constructor(private readonly options: AgentRuntimeRequestDispatcherOptions) {}

  async dispatch<TMethod extends AgentRpcMethod>(
    request: AgentRpcRequest<TMethod>,
  ): Promise<AgentRpcMethodMap[TMethod]['result']> {
    validateProtocolVersion(request.protocolVersion);
    validateMethod(request.method);

    if (request.method !== 'ping') {
      this.requireAuthorizedToken(request.token);
    }
    if (this.options.isStopping() && request.method !== 'ping') {
      throw new AgentRpcRequestError({
        code: 'SHUTTING_DOWN',
        message: 'Agent runtime is shutting down',
        retryable: true,
      });
    }

    switch (request.method) {
      case 'ping':
        return this.getPingResult() as AgentRpcMethodMap[TMethod]['result'];
      case 'status': {
        const params = (request.params ?? {}) as AgentRpcMethodMap['status']['params'];
        const result = await this.enqueue(() => this.requireCommandExecutor().status(params));
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'listProjects': {
        const result = await this.enqueue(() => this.requireCommandExecutor().listProjects());
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'registerProject': {
        const params = request.params as AgentRpcMethodMap['registerProject']['params'];
        const result = await this.enqueue(() => this.executeIdempotent('registerProject', params.idempotencyKey, async () => (
          this.requireCommandExecutor().registerProject({
            remoteFingerprint: params.remoteFingerprint,
            displayName: params.displayName,
            workspacePath: params.workspacePath,
            workspaceFingerprint: params.workspaceFingerprint,
            preferredActiveBranch: params.preferredActiveBranch,
          })
        )));
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'syncProject': {
        const params = request.params as AgentRpcMethodMap['syncProject']['params'];
        const result = await this.enqueue(() => this.executeIdempotent('syncProject', params.idempotencyKey, async () => (
          this.requireCommandExecutor().syncProject({
            bindingId: params.bindingId,
            targets: params.targets,
          })
        )));
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'unbindProject': {
        const params = request.params as AgentRpcMethodMap['unbindProject']['params'];
        const result = await this.enqueue(async () => {
          await this.executeIdempotent('unbindProject', params.idempotencyKey, async () => {
            await this.requireCommandExecutor().unbindProject(params.bindingId);
            return {};
          });
          return {};
        });
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'cleanProject': {
        const params = request.params as AgentRpcMethodMap['cleanProject']['params'];
        const result = await this.enqueue(() => this.executeIdempotent('cleanProject', params.idempotencyKey, async () => (
          this.requireCommandExecutor().cleanProject(params.bindingId)
        )));
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'searchHead': {
        const params = request.params as AgentRpcMethodMap['searchHead']['params'];
        const result = await this.enqueue(() => this.requireSearchHeadService().searchByLocalHead(params));
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      case 'shutdown': {
        const params = request.params as AgentRpcMethodMap['shutdown']['params'];
        const result = await this.enqueue(async () => {
          const result = await this.executeIdempotent('shutdown', params.idempotencyKey, async () => ({
            accepted: true as const,
          }));
          this.options.onShutdownAccepted();
          return result;
        });
        return result as AgentRpcMethodMap[TMethod]['result'];
      }
      default:
        throw new AgentRpcRequestError({
          code: 'UNKNOWN_METHOD',
          message: `Unknown RPC method: ${String(request.method)}`,
          retryable: false,
        });
    }
  }

  private async executeIdempotent<TResult>(
    method: AgentRpcMethod,
    idempotencyKey: string | undefined,
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
    const existing = await store.read<TResult>(method, idempotencyKey);
    if (existing) {
      return fromStoredIdempotentRecord(existing);
    }

    try {
      const result = await task();
      await store.writeSuccess(method, idempotencyKey, result);
      return result;
    } catch (error) {
      const rpcError = toRpcError(error);
      await store.writeError(method, idempotencyKey, rpcError);
      throw new AgentRpcRequestError(rpcError);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.options.queue.enqueue(task);
  }

  private getPingResult(): AgentRuntimePingResult {
    const meta = this.requireMeta();
    return {
      protocolVersion: meta.protocolVersion,
      instanceId: meta.instanceId,
      startedAt: meta.startedAt,
      pid: meta.pid,
      dataDir: this.options.dataDir,
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

function validateProtocolVersion(protocolVersion: number): void {
  if (protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) {
    throw new AgentRpcRequestError({
      code: 'PROTOCOL_MISMATCH',
      message: `Protocol version mismatch: runtime=${AGENT_RUNTIME_PROTOCOL_VERSION}, client=${protocolVersion}`,
      retryable: false,
    });
  }
}

function validateMethod(method: string): asserts method is AgentRpcMethod {
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
}

function fromStoredIdempotentRecord<TResult>(record: StoredIdempotentRecord<TResult>): TResult {
  if (record.kind === 'success') {
    return record.result;
  }

  throw new AgentRpcRequestError(record.error);
}

export function toRpcError(error: unknown): AgentRpcError {
  if (error instanceof AgentRpcRequestError) {
    return error.rpcError;
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
