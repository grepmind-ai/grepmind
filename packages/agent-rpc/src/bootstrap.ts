import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  isRuntimeUnavailableError,
} from './client.js';
import {
  inspectCredentialPayload,
  type AgentCredentialInspection,
} from './credential-inspection.js';
import { getAgentRuntimeLogPath } from './control.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGENT_DATA_DIR = path.join(
  os.homedir(),
  '.grepmind-agent',
);
export const AGENT_CONFIG_FILENAME = 'agent-config.json';

const DEFAULT_AGENT_COMMAND: AgentControlCommand = {
  command: 'grepmind-agent',
  baseArgs: [],
};
const DEFAULT_RUNTIME_READY_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const READY_POLL_INTERVAL_MS = 200;
const KEYCHAIN_SERVICE = 'grepmind-agent';
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AGENT_ACCOUNT_SESSION_HEADER = 'x-grepmind-agent-account-session';
const AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER =
  'x-grepmind-agent-capability';
const AGENT_ACCOUNT_SESSION_DEVICE_HEADER = 'x-grepmind-agent-device-id';
const AGENT_ACCOUNT_SESSION_CAPABILITY = 'account-session/v1';

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

interface StoredAgentAccountSession {
  token: string;
  deviceId: string;
  expiresAt: string;
  refreshAfter: string;
  account: {
    accountId: number;
    displayName: string;
    clerkOrgSlug: string | null;
  };
}

interface StoredOAuthCredential {
  credentialType: 'oauth_token';
  host: string;
  apiBaseUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenEndpoint: string;
  userInfoEndpoint?: string;
  oauthClientId: string;
  scopes: string[];
  expiresAt: string;
  accountSubject: string | null;
  accountEmail: string | null;
  accountSession?: StoredAgentAccountSession;
}

export type AgentCredentialStatus =
  | 'available'
  | 'missing'
  | 'invalid'
  | 'unavailable'
  | 'unsupported'
  | 'not_configured';

export type AgentAccountSessionStatus =
  | 'available'
  | 'missing'
  | 'expired'
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
  accountSessionStatus: AgentAccountSessionStatus;
  accountSessionExpiresAt: string | null;
  selectedAccountId: number | null;
  selectedAccountName: string | null;
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
  extends EnsureAgentAuthOptions, EnsureAgentRuntimeOptions {}

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
      accountSessionStatus: 'not_configured',
      accountSessionExpiresAt: null,
      selectedAccountId: null,
      selectedAccountName: null,
      credentialStoreKind: null,
      config,
    };
  }

  const credential = await inspectCredential(config.auth);
  const credentialStatus = credential.status;
  const expiresAtMs = Date.parse(config.auth.expiresAt);
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  const accountSessionStatus = credential.accountSessionStatus;

  return {
    dataDir,
    configPath,
    loggedIn:
      credentialStatus === 'available' && accountSessionStatus === 'available',
    credentialStatus,
    needsLogin:
      credentialStatus !== 'available' || accountSessionStatus !== 'available',
    host: config.auth.host,
    apiBaseUrl: config.apiBaseUrl,
    accountSubject: config.auth.accountSubject,
    accountEmail: config.auth.accountEmail,
    expiresAt: config.auth.expiresAt,
    expired,
    accountSessionStatus,
    accountSessionExpiresAt: credential.accountSessionExpiresAt,
    selectedAccountId: credential.selectedAccountId,
    selectedAccountName: credential.selectedAccountName,
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

  const refreshedStatus = await refreshExpiredAccountSessionIfPossible(
    dataDir,
    status,
  );
  if (refreshedStatus && !refreshedStatus.needsLogin) {
    return refreshedStatus;
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
  const runtimeLogPath = getAgentRuntimeLogPath(dataDir);
  await spawnDetachedAgentCommand({
    command: options.command,
    runtimeLogPath,
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
  runtimeLogPath: string;
}): Promise<void> {
  const command = normalizeCommand(input.command);
  await mkdir(path.dirname(input.runtimeLogPath), { recursive: true });
  const stdoutFd = openSync(input.runtimeLogPath, 'a');
  const stderrFd = openSync(input.runtimeLogPath, 'a');
  let child;
  try {
    child = spawn(command.command, [...command.baseArgs, ...input.args], {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: process.env,
      cwd: process.cwd(),
    });
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

function normalizeCommand(command?: AgentControlCommand): {
  command: string;
  baseArgs: string[];
} {
  return {
    command: command?.command ?? DEFAULT_AGENT_COMMAND.command,
    baseArgs: command?.baseArgs ?? DEFAULT_AGENT_COMMAND.baseArgs ?? [],
  };
}

async function inspectCredential(
  auth: AgentCliAuthConfig,
): Promise<AgentCredentialInspection> {
  if (process.platform !== 'darwin') {
    const status =
      auth.credentialStoreKind === 'unsupported'
        ? 'unsupported'
        : 'unavailable';
    return {
      status,
      accountSessionStatus: status,
      accountSessionExpiresAt: null,
      selectedAccountId: null,
      selectedAccountName: null,
    };
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
    return inspectCredentialPayload(stdout);
  } catch (error) {
    if (isSecurityItemNotFound(error)) {
      return {
        status: 'missing',
        accountSessionStatus: 'missing',
        accountSessionExpiresAt: null,
        selectedAccountId: null,
        selectedAccountName: null,
      };
    }
    return {
      status: 'unavailable',
      accountSessionStatus: 'unavailable',
      accountSessionExpiresAt: null,
      selectedAccountId: null,
      selectedAccountName: null,
    };
  }
}

async function refreshExpiredAccountSessionIfPossible(
  dataDir: string,
  status: AgentAuthStatus,
): Promise<AgentAuthStatus | null> {
  if (
    status.credentialStatus !== 'available' ||
    status.accountSessionStatus !== 'expired' ||
    !status.config?.auth
  ) {
    return null;
  }

  try {
    const credential = await loadStoredCredential(status.config.auth);
    if (!credential.accountSession) {
      return null;
    }

    const credentialWithFreshAccessToken =
      await refreshOAuthCredentialIfNeeded(status.config, credential);
    const accountSession = await refreshStoredAccountSession(
      credentialWithFreshAccessToken,
    );
    await saveStoredCredential(status.config.auth.credentialStoreKey, {
      ...credentialWithFreshAccessToken,
      accountSession,
    });
    return getAgentAuthStatus(dataDir);
  } catch {
    return null;
  }
}

async function refreshOAuthCredentialIfNeeded(
  config: AgentCliConfigSnapshot & { auth: AgentCliAuthConfig },
  credential: StoredOAuthCredential,
): Promise<StoredOAuthCredential> {
  if (!needsOAuthRefresh(credential.expiresAt)) {
    return credential;
  }

  const response = await fetch(credential.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.oauthClientId,
      refresh_token: credential.refreshToken,
      ...(credential.scopes.length > 0
        ? { scope: credential.scopes.join(' ') }
        : {}),
    }),
  });
  const payload = await readJsonObject(response);
  if (!response.ok || typeof payload.error === 'string') {
    throw new Error(
      `AUTH_REFRESH_FAILED: ${
        typeof payload.error_description === 'string'
          ? payload.error_description
          : typeof payload.error === 'string'
            ? payload.error
            : `HTTP ${response.status}`
      }`,
    );
  }
  if (typeof payload.access_token !== 'string') {
    throw new Error(
      'AUTH_REFRESH_FAILED: refresh response did not include an access token',
    );
  }
  if (
    typeof payload.token_type !== 'string' ||
    payload.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new Error(
      'AUTH_REFRESH_FAILED: refresh response token_type must be Bearer',
    );
  }
  if (typeof payload.expires_in !== 'number' || payload.expires_in <= 0) {
    throw new Error(
      'AUTH_REFRESH_FAILED: refresh response did not include a valid expires_in',
    );
  }

  const nextCredential: StoredOAuthCredential = {
    ...credential,
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : credential.refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
  };
  await saveStoredCredential(config.auth.credentialStoreKey, nextCredential);
  await updateStoredConfigAuthExpiresAt(config, nextCredential.expiresAt).catch(
    () => {},
  );
  return nextCredential;
}

async function refreshStoredAccountSession(
  credential: StoredOAuthCredential,
): Promise<StoredAgentAccountSession> {
  const current = credential.accountSession;
  if (!current) {
    throw new Error('AGENT_ACCOUNT_SESSION_REQUIRED: stored session missing');
  }

  const response = await fetch(
    `${credential.apiBaseUrl.replace(/\/+$/, '')}/api/agent/account-sessions/refresh`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        [AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER]:
          AGENT_ACCOUNT_SESSION_CAPABILITY,
        [AGENT_ACCOUNT_SESSION_DEVICE_HEADER]: current.deviceId,
        [AGENT_ACCOUNT_SESSION_HEADER]: current.token,
      },
      body: '{}',
    },
  );
  const payload = await readJsonObject(response);
  if (!response.ok) {
    throw new Error(
      `${
        typeof payload.code === 'string'
          ? payload.code
          : 'AGENT_ACCOUNT_SESSION_REFRESH_FAILED'
      }: ${
        typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`
      }`,
    );
  }

  return normalizeAccountSessionResponse(payload, current.deviceId);
}

function needsOAuthRefresh(expiresAt: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() + OAUTH_REFRESH_SKEW_MS
  );
}

async function loadStoredCredential(
  auth: AgentCliAuthConfig,
): Promise<StoredOAuthCredential> {
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
  return parseStoredCredential(stdout);
}

async function saveStoredCredential(
  credentialStoreKey: string,
  credential: StoredOAuthCredential,
): Promise<void> {
  await execFileAsync(
    '/usr/bin/security',
    [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      credentialStoreKey,
      '-w',
      JSON.stringify(credential),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

function parseStoredCredential(raw: string): StoredOAuthCredential {
  const parsed = JSON.parse(raw.trim()) as Partial<StoredOAuthCredential>;
  if (
    parsed.credentialType !== 'oauth_token' ||
    typeof parsed.host !== 'string' ||
    typeof parsed.apiBaseUrl !== 'string' ||
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.refreshToken !== 'string' ||
    typeof parsed.tokenEndpoint !== 'string' ||
    typeof parsed.oauthClientId !== 'string' ||
    typeof parsed.expiresAt !== 'string' ||
    !Array.isArray(parsed.scopes)
  ) {
    throw new Error(
      'AUTH_CREDENTIAL_INVALID: secure credential payload is invalid',
    );
  }

  const accountSession = normalizeStoredAccountSession(parsed.accountSession);
  return {
    credentialType: 'oauth_token',
    host: parsed.host,
    apiBaseUrl: parsed.apiBaseUrl,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    tokenEndpoint: parsed.tokenEndpoint,
    ...(typeof parsed.userInfoEndpoint === 'string'
      ? { userInfoEndpoint: parsed.userInfoEndpoint }
      : {}),
    oauthClientId: parsed.oauthClientId,
    scopes: parsed.scopes.filter(
      (scope): scope is string => typeof scope === 'string',
    ),
    expiresAt: parsed.expiresAt,
    accountSubject:
      typeof parsed.accountSubject === 'string' ? parsed.accountSubject : null,
    accountEmail:
      typeof parsed.accountEmail === 'string' ? parsed.accountEmail : null,
    ...(accountSession ? { accountSession } : {}),
  };
}

function normalizeStoredAccountSession(
  value: unknown,
): StoredAgentAccountSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<StoredAgentAccountSession>;
  return normalizeAccountSessionPayload(
    {
      accountSessionToken: record.token,
      expiresAt: record.expiresAt,
      refreshAfter: record.refreshAfter,
      account: record.account,
    },
    typeof record.deviceId === 'string' ? record.deviceId : null,
  );
}

function normalizeAccountSessionResponse(
  payload: Record<string, unknown>,
  deviceId: string,
): StoredAgentAccountSession {
  return normalizeAccountSessionPayload(payload, deviceId);
}

function normalizeAccountSessionPayload(
  payload: Record<string, unknown>,
  deviceId: string | null,
): StoredAgentAccountSession {
  const account =
    payload.account &&
    typeof payload.account === 'object' &&
    !Array.isArray(payload.account)
      ? (payload.account as Record<string, unknown>)
      : null;
  if (
    typeof payload.accountSessionToken !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof payload.expiresAt !== 'string' ||
    typeof payload.refreshAfter !== 'string' ||
    !account ||
    typeof account.accountId !== 'number' ||
    typeof account.displayName !== 'string'
  ) {
    throw new Error('AGENT_ACCOUNT_SESSION_INVALID: session payload invalid');
  }

  return {
    token: payload.accountSessionToken,
    deviceId,
    expiresAt: payload.expiresAt,
    refreshAfter: payload.refreshAfter,
    account: {
      accountId: account.accountId,
      displayName: account.displayName,
      clerkOrgSlug:
        typeof account.clerkOrgSlug === 'string' ? account.clerkOrgSlug : null,
    },
  };
}

async function updateStoredConfigAuthExpiresAt(
  config: AgentCliConfigSnapshot & { auth: AgentCliAuthConfig },
  expiresAt: string,
): Promise<void> {
  const configPath = getAgentConfigPath(config.dataDir);
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const auth =
    parsed.auth && typeof parsed.auth === 'object' && !Array.isArray(parsed.auth)
      ? (parsed.auth as Record<string, unknown>)
      : null;
  if (!auth) {
    return;
  }

  parsed.auth = {
    ...auth,
    expiresAt,
  };
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(configPath, 0o600).catch(() => {});
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as unknown;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
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
