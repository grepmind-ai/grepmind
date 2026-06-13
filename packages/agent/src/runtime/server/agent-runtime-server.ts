import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { AgentRunner } from '../../cli/agent-runner.js';
import type { AgentCliConfig } from '../../cli/config.js';
import { AgentCommandExecutor } from '../../commands/agent-command-executor.js';
import {
  noopAgentLogger,
  type AgentLogger,
} from '../../logging/agent-logger.js';
import { SearchHeadService } from '../../services/search-head-service.js';
import {
  acquireAgentRuntimeLock,
  chmodSocketPrivate,
  cleanupRuntimeArtifactFiles,
  cleanupStaleRuntimeArtifacts,
  getAgentSocketPath,
  getAgentRuntimeLogPath,
  writeAgentMetaFile,
  writeAgentPidFile,
  type AgentRuntimeLock,
} from '../control.js';
import { AgentRpcIdempotencyStore } from '../rpc/idempotency-store.js';
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRpcRequest,
  type AgentRpcResponse,
  type AgentRuntimeMeta,
} from '../rpc/protocol.js';
import { SingleWriterQueue } from '../single-writer-queue.js';
import { AgentRpcRequestError } from './rpc-errors.js';
import {
  AgentRuntimeRequestDispatcher,
  toRpcError,
} from './request-dispatcher.js';

const MAX_RPC_REQUEST_BYTES = 1_048_576;

export interface AgentRuntimeServerOptions {
  logger?: AgentLogger;
}

export class AgentRuntimeServer {
  private readonly logger: AgentLogger;
  private readonly queue = new SingleWriterQueue();
  private readonly runner: AgentRunner;
  private readonly requestDispatcher: AgentRuntimeRequestDispatcher;
  private readonly stopped = createDeferred<void>();
  private lock: AgentRuntimeLock | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private commandExecutor: AgentCommandExecutor | null = null;
  private searchHeadService: SearchHeadService | null = null;
  private idempotencyStore: AgentRpcIdempotencyStore | null = null;
  private meta: AgentRuntimeMeta | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private ownsSocket = false;
  private ownsPidFile = false;
  private starting = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly config: AgentCliConfig,
    options: AgentRuntimeServerOptions = {},
  ) {
    this.logger = options.logger ?? noopAgentLogger;
    this.runner = new AgentRunner(config, {
      logger: this.logger,
      bootstrapOnInit: false,
      onStopRequested: () => {
        void this.stop();
      },
    });
    this.requestDispatcher = new AgentRuntimeRequestDispatcher({
      dataDir: config.dataDir,
      queue: this.queue,
      getMeta: () => this.meta,
      isStopping: () => this.stopping,
      getCommandExecutor: () => this.commandExecutor,
      getSearchHeadService: () => this.searchHeadService,
      getIdempotencyStore: () => this.idempotencyStore,
      onShutdownAccepted: () => {
        setImmediate(() => {
          void this.stop();
        });
      },
    });
  }

  async start(): Promise<void> {
    if (this.meta || this.starting) {
      return;
    }

    this.starting = true;

    try {
      this.lock = await acquireAgentRuntimeLock(this.config.dataDir);
      await cleanupStaleRuntimeArtifacts(this.config.dataDir);

      await this.runner.start();
      const runtime = await this.runner.getRuntime();
      this.commandExecutor = new AgentCommandExecutor(runtime, {
        syncHead: (bindingId) => this.runner.syncHead(bindingId),
      });
      this.searchHeadService = new SearchHeadService({
        projects: runtime.projects,
        revisionAttachments: runtime.repositories.projectRevisionAttachments,
        searchTransport: this.runner,
      });
      this.idempotencyStore = new AgentRpcIdempotencyStore(runtime.db);

      this.meta = {
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        instanceId: randomUUID(),
        startedAt: new Date().toISOString(),
        pid: process.pid,
        socketPath: getAgentSocketPath(this.config.dataDir),
        runtimeLogPath: getAgentRuntimeLogPath(this.config.dataDir),
        token: randomUUID(),
      };

      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });
      this.server.on('error', (error) => {
        if (!this.stopping) {
          this.logger.error(
            'runtime',
            'Agent runtime socket server failed',
            error,
          );
          void this.stop();
        }
      });

      await listenOnSocket(this.server, this.meta.socketPath);
      this.ownsSocket = true;
      await chmodSocketPrivate(this.meta.socketPath);
      await writeAgentPidFile(this.config.dataDir, this.meta.pid);
      this.ownsPidFile = true;
      await writeAgentMetaFile(this.config.dataDir, this.meta);

      this.logger.success(
        'runtime',
        `Agent runtime ready on ${this.meta.socketPath}`,
      );
      this.scheduleNextTick(0);
    } catch (error) {
      await this.cleanupAfterFailedStart();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async waitForStop(): Promise<void> {
    await this.stopped.promise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    this.runner.requestStop();
    this.logger.info('runtime', 'Stopping agent runtime');

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    const server = this.server;
    this.server = null;
    const closeServerPromise = server ? closeServer(server) : Promise.resolve();

    await this.queue.waitForIdle();

    for (const socket of this.sockets) {
      socket.end();
    }
    await closeServerPromise.catch((error) => {
      this.logger.error(
        'runtime',
        'Failed to close agent runtime server cleanly',
        error,
      );
    });

    await this.runner.stop().catch((error) => {
      this.logger.error(
        'runtime',
        'Failed to stop agent runner cleanly',
        error,
      );
    });
    if (this.ownsSocket || this.ownsPidFile) {
      await cleanupRuntimeArtifactFiles(this.config.dataDir).catch((error) => {
        this.logger.error('runtime', 'Failed to remove runtime files', error);
      });
    }
    this.ownsSocket = false;
    this.ownsPidFile = false;
    await this.lock?.release().catch((error) => {
      this.logger.error('runtime', 'Failed to release runtime lock', error);
    });
    this.lock = null;
    this.meta = null;
    this.searchHeadService = null;

    this.stopped.resolve();
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;

    socket.on('data', (chunk: string) => {
      if (handled) {
        return;
      }

      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RPC_REQUEST_BYTES) {
        handled = true;
        this.writeResponse(socket, {
          id: 'unknown',
          ok: false,
          error: toRpcError(
            new AgentRpcRequestError({
              code: 'INVALID_REQUEST',
              message: `Request payload exceeds ${MAX_RPC_REQUEST_BYTES} bytes`,
              retryable: false,
            }),
          ),
        });
        return;
      }

      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newlineIndex).trim();
      void this.handleRequestLine(socket, line);
    });
    socket.on('error', (error) => {
      if (!this.stopping) {
        this.logger.error(
          'runtime',
          'Agent runtime socket client error',
          error,
        );
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
  }

  private async handleRequestLine(socket: Socket, line: string): Promise<void> {
    let requestId = 'unknown';

    try {
      if (line.length === 0) {
        throw new AgentRpcRequestError({
          code: 'INVALID_REQUEST',
          message: 'Request payload is empty',
          retryable: false,
        });
      }

      const request = JSON.parse(line) as AgentRpcRequest;
      requestId = typeof request.id === 'string' ? request.id : 'unknown';
      const result = await this.requestDispatcher.dispatch(request);
      this.writeResponse(socket, {
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      this.writeResponse(socket, {
        id: requestId,
        ok: false,
        error: toRpcError(error),
      });
    }
  }

  private writeResponse(socket: Socket, response: AgentRpcResponse): void {
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopping) {
      return;
    }

    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.queue
        .enqueue(async () => {
          if (this.stopping) {
            return;
          }
          await this.runner.runOnce();
        })
        .catch((error) => {
          this.logger.error(
            'runtime',
            'Agent runtime run iteration failed',
            error,
          );
        })
        .finally(() => {
          this.scheduleNextTick(this.config.headPollIntervalMs);
        });
    }, delayMs);
  }

  private async cleanupAfterFailedStart(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    if (this.server) {
      await closeServer(this.server).catch(() => {});
    }
    this.server = null;
    await this.runner.stop().catch(() => {});
    if (this.ownsSocket || this.ownsPidFile) {
      await cleanupRuntimeArtifactFiles(this.config.dataDir).catch(() => {});
    }
    this.ownsSocket = false;
    this.ownsPidFile = false;
    await this.lock?.release().catch(() => {});
    this.lock = null;
    this.meta = null;
    this.searchHeadService = null;
  }
}

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
