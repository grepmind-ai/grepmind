import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
} from '@grepmind/agent-rpc';
import { getAgentRuntimeLogPath } from './control.js';

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
  const runtimeLogPath = getAgentRuntimeLogPath(dataDir);
  await mkdir(dataDir, { recursive: true });
  const stdoutFd = openSync(runtimeLogPath, 'a');
  const stderrFd = openSync(runtimeLogPath, 'a');
  let child;
  try {
    child = spawn(
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
        stdio: ['ignore', stdoutFd, stderrFd],
        env: process.env,
        cwd: process.cwd(),
      },
    );
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      reject(error);
    });
    child.once('spawn', () => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolve();
    });
  });
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
