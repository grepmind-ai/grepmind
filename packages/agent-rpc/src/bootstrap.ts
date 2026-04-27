import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  isRuntimeUnavailableError,
} from './client.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGENT_DATA_DIR = path.join(os.homedir(), '.grepmind-agent');
export const AGENT_CONFIG_FILENAME = 'agent-config.json';

const DEFAULT_AGENT_COMMAND: AgentControlCommand = {
  command: 'grepmind-agent',
  baseArgs: [],
};
const DEFAULT_RUNTIME_READY_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const READY_POLL_INTERVAL_MS = 200;
const KEYCHAIN_SERVICE = 'grepmind-agent';

export interface AgentControlCommand {
  command: string;
  baseArgs?: string[];
}

export interface AgentCliAuthConfig {
  credentialType: 'oauth_token';
  host: string;
  accountSubject: string | null;
  accountEmail: string | null;
  expiresAt: string;
  credentialStoreKey: string;
  credentialStoreKind: string;
  oauthClientId: string;
}

export interface AgentCliConfigSnapshot {
  apiBaseUrl: string;
  name: string;
  pollIntervalMs?: number;
  headPollIntervalMs?: number;
  deviceId?: string;
  dataDir: string;
  auth?: AgentCliAuthConfig;
}

export type AgentCredentialStatus =
  | 'available'
  | 'missing'
  | 'invalid'
  | 'unavailable'
  | 'unsupported'
  | 'not_configured';

export interface AgentAuthStatus {
  dataDir: string;
  configPath: string;
  loggedIn: boolean;
  credentialStatus: AgentCredentialStatus;
  needsLogin: boolean;
  host: string | null;
  apiBaseUrl: string | null;
  accountSubject: string | null;
  accountEmail: string | null;
  expiresAt: string | null;
  expired: boolean;
  credentialStoreKind: string | null;
  config: AgentCliConfigSnapshot | null;
  errorMessage?: string;
}

export interface AgentLoginOptions {
  dataDir?: string;
  hostname: string;
  command?: AgentControlCommand;
  noOpen?: boolean;
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface EnsureAgentAuthOptions {
  dataDir?: string;
  hostname?: string;
  command?: AgentControlCommand;
  noOpen?: boolean;
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface EnsureAgentRuntimeOptions {
  dataDir?: string;
  command?: AgentControlCommand;
  timeoutMs?: number;
  traceEnabled?: boolean;
}

export interface EnsureAgentReadyOptions
  extends EnsureAgentAuthOptions,
    EnsureAgentRuntimeOptions {}

export interface EnsureAgentReadyResult {
  dataDir: string;
  auth: AgentAuthStatus;
  runtime: {
    started: boolean;
    ping: Awaited<ReturnType<AgentRuntimeClient['ping']>>;
  };
}

export function resolveAgentDataDir(input?: string): string {
  const configured = input ?? process.env.GREPMIND_AGENT_DATA_DIR;
  const trimmed = configured?.trim();
  if (!trimmed) {
    return DEFAULT_AGENT_DATA_DIR;
  }
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(process.cwd(), trimmed);
}

export function getAgentConfigPath(dataDir: string): string {
  return path.join(dataDir, AGENT_CONFIG_FILENAME);
}

export async function readAgentCliConfig(
  dataDirInput?: string,
): Promise<AgentCliConfigSnapshot | null> {
  const dataDir = resolveAgentDataDir(dataDirInput);
  try {
    const raw = await readFile(getAgentConfigPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentCliConfigSnapshot>;
    if (!parsed.apiBaseUrl || typeof parsed.apiBaseUrl !== 'string') {
      return null;
    }
    if (!parsed.name || typeof parsed.name !== 'string') {
      return null;
    }

    const auth = normalizeAuthConfig((parsed as { auth?: unknown }).auth);
    return {
      apiBaseUrl: parsed.apiBaseUrl,
      name: parsed.name,
      ...(typeof parsed.pollIntervalMs === 'number'
        ? { pollIntervalMs: parsed.pollIntervalMs }
        : {}),
      ...(typeof parsed.headPollIntervalMs === 'number'
        ? { headPollIntervalMs: parsed.headPollIntervalMs }
        : {}),
      ...(typeof parsed.deviceId === 'string'
        ? { deviceId: parsed.deviceId }
        : {}),
      dataDir,
      ...(auth ? { auth } : {}),
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function getAgentAuthStatus(
  dataDirInput?: string,
): Promise<AgentAuthStatus> {
  const dataDir = resolveAgentDataDir(dataDirInput);
  const configPath = getAgentConfigPath(dataDir);
  const config = await readAgentCliConfig(dataDir);
  if (!config?.auth) {
    return {
      dataDir,
      configPath,
      loggedIn: false,
      credentialStatus: 'not_configured',
      needsLogin: true,
      host: null,
      apiBaseUrl: config?.apiBaseUrl ?? null,
      accountSubject: null,
      accountEmail: null,
      expiresAt: null,
      expired: false,
      credentialStoreKind: null,
      config,
    };
  }

  const credentialStatus = await getCredentialStatus(config.auth);
  const expiresAtMs = Date.parse(config.auth.expiresAt);
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();

  return {
    dataDir,
    configPath,
    loggedIn: credentialStatus === 'available',
    credentialStatus,
    needsLogin: credentialStatus !== 'available',
    host: config.auth.host,
    apiBaseUrl: config.apiBaseUrl,
    accountSubject: config.auth.accountSubject,
    accountEmail: config.auth.accountEmail,
    expiresAt: config.auth.expiresAt,
    expired,
    credentialStoreKind: config.auth.credentialStoreKind,
    config,
  };
}

export async function loginAgent(options: AgentLoginOptions): Promise<void> {
  const dataDir = resolveAgentDataDir(options.dataDir);
  const hostname = options.hostname.trim();
  if (!hostname) {
    throw new Error('hostname is required to run agent auth login');
  }

  await runAgentCommand({
    command: options.command,
    args: [
      'auth',
      'login',
      '--hostname',
      hostname,
      '--data-dir',
      dataDir,
      ...(options.noOpen ? ['--no-open'] : []),
      ...(options.extraArgs ?? []),
    ],
    timeoutMs: options.timeoutMs,
  });
}

export async function ensureAgentAuth(
  options: EnsureAgentAuthOptions = {},
): Promise<AgentAuthStatus> {
  const dataDir = resolveAgentDataDir(options.dataDir);
  const status = await getAgentAuthStatus(dataDir);
  if (!status.needsLogin) {
    return status;
  }

  const hostname =
    options.hostname?.trim() ?? process.env.GREPMIND_AGENT_HOSTNAME?.trim();
  if (!hostname) {
    throw new Error(
      `Grepmind agent is not authenticated for ${dataDir}. ` +
        'Set GREPMIND_AGENT_HOSTNAME or run "grepmind agent auth login --hostname <host>".',
    );
  }

  await loginAgent({
    dataDir,
    hostname,
    command: options.command,
    noOpen: options.noOpen,
    timeoutMs: options.timeoutMs,
    extraArgs: options.extraArgs,
  });

  const nextStatus = await getAgentAuthStatus(dataDir);
  if (nextStatus.needsLogin) {
    throw new Error(
      `Grepmind agent auth login completed but credentials are still unavailable for ${dataDir}`,
    );
  }
  return nextStatus;
}

export async function startAgentRuntime(
  options: EnsureAgentRuntimeOptions = {},
): Promise<void> {
  const dataDir = resolveAgentDataDir(options.dataDir);
  await spawnDetachedAgentCommand({
    command: options.command,
    args: [
      'run',
      '--detach',
      '--data-dir',
      dataDir,
      ...(options.traceEnabled ? ['--trace'] : []),
    ],
  });
}

export async function ensureAgentRuntime(
  options: EnsureAgentRuntimeOptions = {},
): Promise<EnsureAgentReadyResult['runtime']> {
  const dataDir = resolveAgentDataDir(options.dataDir);
  const client = new AgentRuntimeClient(dataDir);
  const existing = await pingRuntime(client).catch((error) => {
    if (!isRuntimeUnavailableError(error)) {
      throw error;
    }
    return null;
  });
  if (existing) {
    return {
      started: false,
      ping: existing,
    };
  }

  await startAgentRuntime(options);
  const ping = await waitForAgentRuntimeReady(dataDir, {
    timeoutMs: options.timeoutMs,
  });
  return {
    started: true,
    ping,
  };
}

export async function ensureAgentReady(
  options: EnsureAgentReadyOptions = {},
): Promise<EnsureAgentReadyResult> {
  const dataDir = resolveAgentDataDir(options.dataDir);
  const auth = await ensureAgentAuth({
    ...options,
    dataDir,
  });
  const runtime = await ensureAgentRuntime({
    ...options,
    dataDir,
  });

  return {
    dataDir,
    auth,
    runtime,
  };
}

export async function waitForAgentRuntimeReady(
  dataDirInput?: string,
  options: { timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<AgentRuntimeClient['ping']>>> {
  const dataDir = resolveAgentDataDir(dataDirInput);
  const client = new AgentRuntimeClient(dataDir);
  const deadline =
    Date.now() + (options.timeoutMs ?? DEFAULT_RUNTIME_READY_TIMEOUT_MS);
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await pingRuntime(client);
    } catch (error) {
      if (!isRuntimeReadyWaitError(error)) {
        throw error;
      }
      lastError = error;
      await delay(READY_POLL_INTERVAL_MS);
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

async function pingRuntime(
  client: AgentRuntimeClient,
): Promise<Awaited<ReturnType<AgentRuntimeClient['ping']>>> {
  return client.ping(1_000);
}

async function runAgentCommand(input: {
  command?: AgentControlCommand;
  args: string[];
  timeoutMs?: number;
}): Promise<void> {
  const command = normalizeCommand(input.command);
  const args = [...command.baseArgs, ...input.args];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd: process.cwd(),
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `${command.command} ${args.join(' ')} timed out after ${input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms`,
        ),
      );
    }, input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command.command} ${args.join(' ')} failed with ${signal ?? `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function spawnDetachedAgentCommand(input: {
  command?: AgentControlCommand;
  args: string[];
}): Promise<void> {
  const command = normalizeCommand(input.command);
  const child = spawn(command.command, [...command.baseArgs, ...input.args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    cwd: process.cwd(),
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}

function normalizeCommand(command?: AgentControlCommand): {
  command: string;
  baseArgs: string[];
} {
  return {
    command: command?.command ?? DEFAULT_AGENT_COMMAND.command,
    baseArgs: command?.baseArgs ?? DEFAULT_AGENT_COMMAND.baseArgs ?? [],
  };
}

async function getCredentialStatus(
  auth: AgentCliAuthConfig,
): Promise<AgentCredentialStatus> {
  if (process.platform !== 'darwin') {
    return auth.credentialStoreKind === 'unsupported'
      ? 'unsupported'
      : 'unavailable';
  }

  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        auth.credentialStoreKey,
        '-w',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
    );
    return isValidCredentialPayload(stdout) ? 'available' : 'invalid';
  } catch (error) {
    if (isSecurityItemNotFound(error)) {
      return 'missing';
    }
    return 'unavailable';
  }
}

function normalizeAuthConfig(value: unknown): AgentCliAuthConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Partial<AgentCliAuthConfig>;
  if (
    record.credentialType !== 'oauth_token' ||
    typeof record.host !== 'string' ||
    typeof record.expiresAt !== 'string' ||
    typeof record.credentialStoreKey !== 'string' ||
    typeof record.credentialStoreKind !== 'string' ||
    typeof record.oauthClientId !== 'string'
  ) {
    return undefined;
  }

  return {
    credentialType: 'oauth_token',
    host: record.host,
    accountSubject:
      typeof record.accountSubject === 'string' ? record.accountSubject : null,
    accountEmail:
      typeof record.accountEmail === 'string' ? record.accountEmail : null,
    expiresAt: record.expiresAt,
    credentialStoreKey: record.credentialStoreKey,
    credentialStoreKind: record.credentialStoreKind,
    oauthClientId: record.oauthClientId,
  };
}

function isValidCredentialPayload(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    return (
      parsed.credentialType === 'oauth_token' &&
      typeof parsed.host === 'string' &&
      typeof parsed.apiBaseUrl === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.tokenEndpoint === 'string' &&
      typeof parsed.oauthClientId === 'string' &&
      typeof parsed.expiresAt === 'string'
    );
  } catch {
    return false;
  }
}

function isRuntimeReadyWaitError(error: unknown): boolean {
  return (
    error instanceof AgentRuntimeClientError &&
    (error.code === 'RUNTIME_UNAVAILABLE' ||
      error.code === 'BROKEN_PIPE' ||
      error.code === 'TIMEOUT' ||
      error.code === 'RUNTIME_NOT_READY')
  );
}

function isSecurityItemNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    /could not be found|The specified item could not be found/i.test(
      error.message,
    )
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
