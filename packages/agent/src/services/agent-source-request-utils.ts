import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { promisify } from 'node:util';
import type {
  AgentCommitGraphErrorPayload,
  AgentSnapshotArchiveLimits,
  AgentSnapshotExportErrorPayload,
} from '../backend/contracts/index.js';
import type { RealtimeSend } from '../backend/realtime/types.js';

const execFileAsync = promisify(execFile);
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_STDERR_LENGTH = 8_000;

export type SourceRequestOperation = 'snapshot' | 'commit_graph';

export class AgentSourceRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'AgentSourceRequestError';
    this.code = code;
    this.retryable = retryable;
  }
}

export async function streamGitArchive(
  workspacePath: string,
  commitSha: string,
  archive: AgentSnapshotArchiveLimits,
  requestId: string,
  send: RealtimeSend,
): Promise<{ totalBytes: number; sha256: string }> {
  const prefix = `grepmind-agent-snapshot-${commitSha}/`;
  const child = spawn(
    'git',
    ['archive', '--format=zip', `--prefix=${prefix}`, commitSha],
    {
      cwd: workspacePath,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  let processError: Error | null = null;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = truncate(`${stderr}${String(chunk)}`, MAX_STDERR_LENGTH);
  });
  const exitPromise = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      processError = error instanceof Error ? error : new Error(String(error));
      resolve();
    });
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  const hash = createHash('sha256');
  let totalBytes = 0;
  let sequence = 0;
  let pending = Buffer.alloc(0);
  let tooLarge = false;

  try {
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      if (totalBytes + chunk.length > archive.maxBytes) {
        tooLarge = true;
        child.kill('SIGTERM');
        break;
      }

      totalBytes += chunk.length;
      hash.update(chunk);
      pending =
        pending.length === 0
          ? chunk
          : Buffer.concat([pending, chunk], pending.length + chunk.length);

      while (pending.length >= archive.chunkBytes) {
        const frame = pending.subarray(0, archive.chunkBytes);
        send('snapshot.export.chunk', {
          requestId,
          sequence,
          base64: frame.toString('base64'),
        });
        sequence += 1;
        pending = pending.subarray(archive.chunkBytes);
      }
    }
  } catch (error) {
    if (!tooLarge) {
      throw new AgentSourceRequestError(
        errorMessage(error),
        'SNAPSHOT_EXPORT_FAILED',
        true,
      );
    }
  }

  await exitPromise;

  if (tooLarge) {
    throw new AgentSourceRequestError(
      `Snapshot archive exceeded ${archive.maxBytes} bytes`,
      'SNAPSHOT_TOO_LARGE',
      false,
    );
  }

  if (processError) {
    throw new AgentSourceRequestError(
      errorMessage(processError),
      'SNAPSHOT_EXPORT_FAILED',
      true,
    );
  }

  if (exitCode !== 0) {
    const message = stderr.trim()
      ? stderr.trim()
      : `git archive exited with ${exitCode ?? `signal ${exitSignal ?? 'unknown'}`}`;
    throw new AgentSourceRequestError(message, 'SNAPSHOT_EXPORT_FAILED', true);
  }

  if (pending.length > 0) {
    send('snapshot.export.chunk', {
      requestId,
      sequence,
      base64: pending.toString('base64'),
    });
  }

  return {
    totalBytes,
    sha256: hash.digest('hex'),
  };
}

export function toSnapshotExportErrorPayload(
  requestId: string,
  error: unknown,
): AgentSnapshotExportErrorPayload {
  if (error instanceof AgentSourceRequestError) {
    return {
      requestId,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    requestId,
    code: 'SNAPSHOT_EXPORT_FAILED',
    message: errorMessage(error),
    retryable: true,
  };
}

export function toCommitGraphErrorPayload(
  requestId: string,
  error: unknown,
): AgentCommitGraphErrorPayload {
  if (error instanceof AgentSourceRequestError) {
    return {
      requestId,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    requestId,
    code: 'COMMIT_GRAPH_FAILED',
    message: errorMessage(error),
    retryable: true,
  };
}

export async function runGit(
  workspacePath: string,
  args: string[],
): Promise<string> {
  const { stdout } = (await execFileAsync('git', args, {
    cwd: workspacePath,
    encoding: 'utf8',
    env: gitEnv(),
    maxBuffer: 10 * 1024 * 1024,
  })) as { stdout: string };

  return stdout.trim();
}

export function normalizeCommitSha(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(normalized) ? normalized : null;
}

export function operationFailedCode(operation: SourceRequestOperation): string {
  return operation === 'snapshot'
    ? 'SNAPSHOT_EXPORT_FAILED'
    : 'COMMIT_GRAPH_FAILED';
}

export function isVerifyCommitMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (record.code !== 128) {
    return false;
  }

  const message = `${typeof record.stderr === 'string' ? record.stderr : ''}\n${
    typeof record.message === 'string' ? record.message : ''
  }`;
  return (
    message.includes('Needed a single revision') ||
    message.includes('not a valid object name') ||
    message.includes('unknown revision') ||
    message.includes('bad revision')
  );
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message || 'Unknown agent source request failure');
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function truncate(value: string, maxLength = MAX_ERROR_MESSAGE_LENGTH): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
