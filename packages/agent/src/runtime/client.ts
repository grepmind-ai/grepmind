import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assertSocketOwnedByCurrentUser,
  getAgentSocketPath,
  readAgentMetaFile,
} from './control.js';
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRpcError,
  type AgentRpcMethod,
  type AgentRpcMethodMap,
  type AgentRpcRequest,
  type AgentRpcResponse,
  type AgentRuntimePingResult,
} from './rpc/protocol.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_READY_TIMEOUT_MS = 15_000;

export class AgentRuntimeClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    message: string,
    options: {
      code: string;
      retryable?: boolean;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = 'AgentRuntimeClientError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class AgentRuntimeClient {
  constructor(private readonly dataDir: string) {}

  async ping(timeoutMs = 1_000): Promise<AgentRuntimePingResult> {
    return this.request('ping', undefined, {
      timeoutMs,
      includeToken: false,
    });
  }

  async request<TMethod extends AgentRpcMethod>(
    method: TMethod,
    params: AgentRpcMethodMap[TMethod]['params'],
    options: {
      timeoutMs?: number;
      includeToken?: boolean;
    } = {},
  ): Promise<AgentRpcMethodMap[TMethod]['result']> {
    const includeToken = options.includeToken ?? method !== 'ping';
    const meta = includeToken ? await loadRuntimeMetaOrThrow(this.dataDir) : null;
    const socketPath = meta?.socketPath ?? getAgentSocketPath(this.dataDir);
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    await assertSocketPath(socketPath);
    await assertSocketOwnedByCurrentUser(socketPath);

    const request: AgentRpcRequest<TMethod> = {
      id: randomUUID(),
      method,
      params,
      timeoutMs,
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      token: meta?.token,
    };

    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let settled = false;
      let buffer = '';

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(normalizeTransportError(error));
      };

      socket.setEncoding('utf8');
      socket.setTimeout(timeoutMs, () => {
        fail(
          new AgentRuntimeClientError(
            `Timed out waiting for runtime response to ${method}`,
            {
              code: 'TIMEOUT',
              retryable: true,
            },
          ),
        );
      });

      socket.on('error', fail);
      socket.on('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            handleResponseLine(line);
            return;
          }
          newlineIndex = buffer.indexOf('\n');
        }
      });
      socket.on('end', () => {
        if (!settled) {
          fail(
            new AgentRuntimeClientError('Runtime connection closed before a response was received', {
              code: 'BROKEN_PIPE',
              retryable: true,
            }),
          );
        }
      });

      const handleResponseLine = (line: string): void => {
        try {
          const response = JSON.parse(line) as AgentRpcResponse<TMethod>;
          if (response.id !== request.id) {
            throw new AgentRuntimeClientError(
              `Received mismatched runtime response for request ${request.id}`,
              {
                code: 'PROTOCOL_ERROR',
              },
            );
          }

          settled = true;
          socket.end();

          if (!response.ok) {
            reject(toClientError(response.error));
            return;
          }

          resolve(response.result);
        } catch (error) {
          fail(error);
        }
      };
    });
  }
}

export function isRuntimeUnavailableError(error: unknown): boolean {
  return error instanceof AgentRuntimeClientError
    && (error.code === 'RUNTIME_UNAVAILABLE' || error.code === 'BROKEN_PIPE');
}

export async function spawnAgentRuntimeProcess(
  cliEntrypointUrl: string,
  dataDir: string,
  options: {
    traceEnabled?: boolean;
  } = {},
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(cliEntrypointUrl),
      'run',
      '--data-dir',
      dataDir,
      ...(options.traceEnabled ? ['--trace'] : []),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      cwd: process.cwd(),
    },
  );

  child.unref();
}

export async function waitForAgentRuntimeReady(dataDir: string): Promise<void> {
  const client = new AgentRuntimeClient(dataDir);
  const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await client.ping(1_000);
      return;
    } catch (error) {
      if (!isRetriableReadyWaitError(error)) {
        throw error;
      }
      lastError = error;
      await delay(200);
    }
  }

  throw new AgentRuntimeClientError(
    `Timed out waiting for agent runtime to become ready for ${dataDir}`,
    {
      code: 'RUNTIME_START_TIMEOUT',
      retryable: true,
      details: lastError,
    },
  );
}

async function loadRuntimeMetaOrThrow(dataDir: string) {
  const meta = await readAgentMetaFile(dataDir);
  if (!meta) {
    throw new AgentRuntimeClientError(`Agent runtime is not running for ${dataDir}`, {
      code: 'RUNTIME_UNAVAILABLE',
      retryable: true,
    });
  }
  if (meta.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) {
    throw new AgentRuntimeClientError(
      `Agent runtime protocol mismatch: runtime=${meta.protocolVersion}, cli=${AGENT_RUNTIME_PROTOCOL_VERSION}`,
      {
        code: 'PROTOCOL_MISMATCH',
        retryable: false,
      },
    );
  }

  return meta;
}

async function assertSocketPath(socketPath: string): Promise<void> {
  try {
    await stat(socketPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      throw new AgentRuntimeClientError(`Agent runtime socket is not available at ${socketPath}`, {
        code: 'RUNTIME_UNAVAILABLE',
        retryable: true,
      });
    }
    throw error;
  }
}

function normalizeTransportError(error: unknown): AgentRuntimeClientError {
  if (error instanceof AgentRuntimeClientError) {
    return error;
  }

  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError?.code === 'ENOENT' || nodeError?.code === 'ECONNREFUSED') {
    return new AgentRuntimeClientError('Agent runtime is not running', {
      code: 'RUNTIME_UNAVAILABLE',
      retryable: true,
    });
  }

  return new AgentRuntimeClientError(
    error instanceof Error ? error.message : String(error),
    {
      code: 'RPC_TRANSPORT_ERROR',
      retryable: true,
      details: error,
    },
  );
}

function toClientError(error: AgentRpcError): AgentRuntimeClientError {
  return new AgentRuntimeClientError(error.message, {
    code: error.code,
    retryable: error.retryable,
    details: error.details,
  });
}

function isRetriableReadyWaitError(error: unknown): boolean {
  return error instanceof AgentRuntimeClientError
    && (
      error.code === 'RUNTIME_UNAVAILABLE'
      || error.code === 'BROKEN_PIPE'
      || error.code === 'TIMEOUT'
      || error.code === 'RUNTIME_NOT_READY'
    );
}
