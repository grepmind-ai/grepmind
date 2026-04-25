import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
} from '@grepmind/agent-rpc';

export {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  isRuntimeUnavailableError,
} from '@grepmind/agent-rpc';

const RUNTIME_READY_TIMEOUT_MS = 15_000;

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

function isRetriableReadyWaitError(error: unknown): boolean {
  return (
    error instanceof AgentRuntimeClientError &&
    (error.code === 'RUNTIME_UNAVAILABLE' ||
      error.code === 'BROKEN_PIPE' ||
      error.code === 'TIMEOUT' ||
      error.code === 'RUNTIME_NOT_READY')
  );
}
