import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRuntimeMeta } from './rpc/protocol.js';

export const AGENT_SOCKET_FILENAME = 'agent.sock';
export const AGENT_PID_FILENAME = 'agent.pid';
export const AGENT_META_FILENAME = 'agent.meta.json';
export const AGENT_LOCK_FILENAME = 'agent.lock';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const AGENT_SOCKET_DIRNAME = 'grepmind-agent-runtime';

export interface AgentRuntimeLock {
  path: string;
  release(): Promise<void>;
}

export function getAgentSocketPath(dataDir: string): string {
  const socketId = createHash('sha256').update(dataDir).digest('hex').slice(0, 24);
  return path.join(tmpdir(), AGENT_SOCKET_DIRNAME, `${socketId}.sock`);
}

export function getAgentPidPath(dataDir: string): string {
  return path.join(dataDir, AGENT_PID_FILENAME);
}

export function getAgentMetaPath(dataDir: string): string {
  return path.join(dataDir, AGENT_META_FILENAME);
}

export function getAgentLockPath(dataDir: string): string {
  return path.join(dataDir, AGENT_LOCK_FILENAME);
}

export async function ensurePrivateDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, {
    recursive: true,
    mode: PRIVATE_DIR_MODE,
  });
  await chmod(dataDir, PRIVATE_DIR_MODE).catch(() => {});
  await ensurePrivateSocketDir(dataDir);
}

export async function acquireAgentRuntimeLock(dataDir: string): Promise<AgentRuntimeLock> {
  await ensurePrivateDataDir(dataDir);
  const lockPath = getAgentLockPath(dataDir);

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', PRIVATE_FILE_MODE);
      await handle.writeFile(`${process.pid}\n`, 'utf8');

      let released = false;
      return {
        path: lockPath,
        async release(): Promise<void> {
          if (released) {
            return;
          }
          released = true;
          await handle.close().catch(() => {});
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          });
        },
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'EEXIST') {
        throw error;
      }

      const stale = await isExistingLockStale(dataDir);
      if (!stale) {
        throw new Error(`Agent runtime is already running for ${dataDir}`);
      }

      await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') {
          throw unlinkError;
        }
      });
    }
  }
}

export async function cleanupStaleRuntimeArtifacts(dataDir: string): Promise<void> {
  const pidPath = getAgentPidPath(dataDir);
  const pid = await readPidFile(pidPath);
  if (pid != null && !isProcessAlive(pid)) {
    await unlink(pidPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  await cleanupStaleSocket(getAgentSocketPath(dataDir));
}

export async function cleanupSocketAndPidFiles(dataDir: string): Promise<void> {
  await unlink(getAgentSocketPath(dataDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  await unlink(getAgentPidPath(dataDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

export async function writeAgentPidFile(dataDir: string, pid: number): Promise<void> {
  await writeSecureFile(getAgentPidPath(dataDir), `${pid}\n`);
}

export async function writeAgentMetaFile(dataDir: string, meta: AgentRuntimeMeta): Promise<void> {
  await writeSecureFile(getAgentMetaPath(dataDir), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function readAgentMetaFile(dataDir: string): Promise<AgentRuntimeMeta | null> {
  try {
    const raw = await readFile(getAgentMetaPath(dataDir), 'utf8');
    return JSON.parse(raw) as AgentRuntimeMeta;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function assertSocketOwnedByCurrentUser(socketPath: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid == null) {
    return;
  }

  const socketStat = await stat(socketPath);
  if (typeof socketStat.uid === 'number' && socketStat.uid !== currentUid) {
    throw new Error(`Refusing to use socket not owned by the current user: ${socketPath}`);
  }
}

export async function chmodSocketPrivate(socketPath: string): Promise<void> {
  await chmod(socketPath, PRIVATE_FILE_MODE);
}

async function cleanupStaleSocket(socketPath: string): Promise<void> {
  try {
    await stat(socketPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const probeResult = await probeSocket(socketPath);
  if (probeResult === 'active') {
    throw new Error(`Agent runtime socket is already active at ${socketPath}`);
  }

  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

async function probeSocket(socketPath: string): Promise<'active' | 'stale'> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;

    const finish = (result: 'active' | 'stale'): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(500, () => finish('stale'));
    socket.on('connect', () => finish('active'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'EPIPE') {
        finish('stale');
        return;
      }

      settled = true;
      socket.destroy();
      reject(error);
    });
  });
}

async function isExistingLockStale(dataDir: string): Promise<boolean> {
  const pid = await readPidFile(getAgentPidPath(dataDir))
    ?? await readPidFile(getAgentLockPath(dataDir));

  if (pid == null) {
    return true;
  }

  return !isProcessAlive(pid);
}

async function readPidFile(filePath: string): Promise<number | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EPERM') {
      return true;
    }
    if (nodeError.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function writeSecureFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(filePath, PRIVATE_FILE_MODE).catch(() => {});
}

async function ensurePrivateSocketDir(dataDir: string): Promise<void> {
  const socketDir = path.dirname(getAgentSocketPath(dataDir));
  await mkdir(socketDir, {
    recursive: true,
    mode: PRIVATE_DIR_MODE,
  });
  await chmod(socketDir, PRIVATE_DIR_MODE).catch(() => {});
}
