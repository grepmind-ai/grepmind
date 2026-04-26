import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  ensureDataDir,
  loadAgentCliConfig,
  resolveDataDir,
  type AgentCliConfig,
} from './config.js';
import {
  getCommandMode,
  getIntegerFlag,
  getStringFlag,
  nonEmptyString,
  toInteger,
} from './flags.js';
import type { ParsedArgs } from './parse-args.js';
import {
  AgentRuntimeClient,
  isRuntimeUnavailableError,
} from '../runtime/client.js';

const execFileAsync = promisify(execFile);

export async function executeSocketPreferredCommand<TResult>(
  args: ParsedArgs,
  options: {
    rpc: (client: AgentRuntimeClient) => Promise<TResult>;
  },
): Promise<TResult> {
  const config = await loadConfigForCommand(args);
  const mode = getCommandMode(args);
  if (mode !== 'runtime-only') {
    throw new Error('--mode must be runtime-only');
  }

  const client = new AgentRuntimeClient(config.dataDir);

  try {
    return await options.rpc(client);
  } catch (error) {
    if (!isRuntimeUnavailableError(error)) {
      throw error;
    }

    throw new Error(
      `Agent runtime is not running for ${config.dataDir}. Start it with "grepmind agent run --data-dir ${config.dataDir}" and retry.`,
    );
  }
}

export async function loadConfigForCommand(
  args: ParsedArgs,
): Promise<AgentCliConfig> {
  rejectRemovedAuthFlags(args);
  const dataDir = resolveDataDir(
    getStringFlag(args, 'data-dir') ?? process.env.GREPMIND_AGENT_DATA_DIR,
  );
  await ensureDataDir(dataDir);
  const config = await loadAgentCliConfig(dataDir);

  return {
    ...config,
    apiBaseUrl: config.apiBaseUrl,
    name:
      getStringFlag(args, 'name') ??
      process.env.GREPMIND_AGENT_NAME ??
      config.name,
    pollIntervalMs:
      getIntegerFlag(args, 'poll-interval-ms') ??
      toInteger(process.env.GREPMIND_AGENT_POLL_INTERVAL_MS) ??
      config.pollIntervalMs,
    headPollIntervalMs:
      getIntegerFlag(args, 'head-poll-interval-ms') ??
      toInteger(process.env.GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS) ??
      config.headPollIntervalMs,
    deviceId:
      nonEmptyString(
        getStringFlag(args, 'device-id') ??
          process.env.GREPMIND_AGENT_DEVICE_ID,
      ) ?? config.deviceId,
  };
}

export function rejectRemovedAuthFlags(args: ParsedArgs): void {
  const removedFlags = [
    'url',
    'token',
    'api-key',
    'with-token',
    'with-api-key',
  ];
  const match = removedFlags.find((flag) => args.flags.has(flag));
  if (match) {
    throw new Error(`Unknown flag: --${match}`);
  }
}

export async function loadOptionalConfig(
  dataDir: string,
): Promise<AgentCliConfig | null> {
  try {
    return await loadAgentCliConfig(dataDir);
  } catch {
    return null;
  }
}

export async function resolveWorkspacePath(
  workspacePath: string,
): Promise<string> {
  const resolved = path.resolve(process.cwd(), workspacePath);
  await access(resolved);
  return resolved;
}

export async function resolveWorkspaceRemoteUrl(
  workspacePath: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['remote', 'get-url', 'origin'],
      {
        cwd: workspacePath,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    const remote = stdout.trim();
    if (!remote) {
      throw new Error('git remote get-url origin returned empty output');
    }
    return remote;
  } catch (error) {
    throw new Error(
      `Workspace ${workspacePath} must have an origin remote configured: ${formatError(error)}`,
    );
  }
}

export async function resolveWorkspaceDefaultBranch(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      {
        cwd: workspacePath,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    const remoteHead = stdout.trim();
    const branch = remoteHead.startsWith('origin/')
      ? remoteHead.slice('origin/'.length)
      : remoteHead;
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export function deriveRepoFullNameFromRemoteUrl(
  remoteUrl: string,
): string | undefined {
  const parsed = parseRemoteUrlPath(remoteUrl);
  if (!parsed || parsed.pathSegments.length !== 2) {
    return undefined;
  }

  return parsed.pathSegments.join('/');
}

export const resolveWorkspaceRemoteFingerprint = resolveWorkspaceRemoteUrl;

export function formatError(error: unknown): string {
  if (!error) {
    return '';
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function parseRemoteUrlPath(
  remoteUrl: string,
): { pathSegments: string[] } | null {
  const raw = remoteUrl.trim();
  const scp = /^(?:[A-Za-z0-9._-]+)@(?<host>[^:/\s]+):(?<path>[^?#\s]+)$/.exec(raw);
  if (scp?.groups?.path && !/^\d+\//.test(scp.groups.path)) {
    return normalizePath(scp.groups.path);
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.search || url.hash || url.password) {
      return null;
    }
    if (url.protocol === 'https:' && url.username) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
      return null;
    }
    return normalizePath(url.pathname);
  } catch {
    return null;
  }
}

function normalizePath(pathname: string): { pathSegments: string[] } | null {
  const trimmed = pathname.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const withoutGit = trimmed.replace(/\.git$/i, '');
  const pathSegments = withoutGit
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  return pathSegments.length >= 2 ? { pathSegments } : null;
}

export function isIdleSyncResult(result: {
  revisionCount: number;
  materializedPlanCount: number;
  invalidationCount: number;
}): boolean {
  return (
    result.revisionCount === 0 &&
    result.materializedPlanCount === 0 &&
    result.invalidationCount === 0
  );
}
