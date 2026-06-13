import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentRuntimeMeta } from './protocol.js';

export const AGENT_META_FILENAME = 'agent.meta.json';
export const AGENT_RUNTIME_LOG_FILENAME = 'agent-runtime.log';

const AGENT_SOCKET_DIRNAME = 'grepmind-agent-runtime';

export function getAgentSocketPath(dataDir: string): string {
  const socketId = createHash('sha256')
    .update(dataDir)
    .digest('hex')
    .slice(0, 24);
  return path.join(tmpdir(), AGENT_SOCKET_DIRNAME, `${socketId}.sock`);
}

export function getAgentMetaPath(dataDir: string): string {
  return path.join(dataDir, AGENT_META_FILENAME);
}

export function getAgentRuntimeLogPath(dataDir: string): string {
  return path.join(dataDir, AGENT_RUNTIME_LOG_FILENAME);
}

export async function readAgentMetaFile(
  dataDir: string,
): Promise<AgentRuntimeMeta | null> {
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

export async function assertSocketOwnedByCurrentUser(
  socketPath: string,
): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid == null) {
    return;
  }

  const socketStat = await stat(socketPath);
  if (typeof socketStat.uid === 'number' && socketStat.uid !== currentUid) {
    throw new Error(
      `Refusing to use socket not owned by the current user: ${socketPath}`,
    );
  }
}
