import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackendClientOptions } from '../backend/agent-backend-client.js';
import type { AgentLogger } from '../logging/agent-logger.js';

export interface AgentCliConfig {
  apiBaseUrl: string;
  accessToken?: string;
  apiKey?: string;
  name: string;
  pollIntervalMs: number;
  headPollIntervalMs: number;
  deviceId: string;
  dataDir: string;
}

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_HEAD_POLL_INTERVAL_MS = 1_500;
export const DEFAULT_AGENT_NAME = os.hostname();
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.grepmind-agent');
export const AGENT_CONFIG_FILENAME = 'agent-config.json';

export function resolveDataDir(input?: string): string {
  if (!input) {
    return DEFAULT_DATA_DIR;
  }

  if (path.isAbsolute(input)) {
    return input;
  }

  return path.resolve(process.cwd(), input);
}

export function getConfigPath(dataDir: string): string {
  return path.join(dataDir, AGENT_CONFIG_FILENAME);
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
}

export async function loadAgentCliConfig(dataDir: string): Promise<AgentCliConfig> {
  const configPath = getConfigPath(dataDir);
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<AgentCliConfig>;

  if (!parsed.apiBaseUrl || typeof parsed.apiBaseUrl !== 'string') {
    throw new Error(`Invalid agent config at ${configPath}: apiBaseUrl is required`);
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Invalid agent config at ${configPath}: name is required`);
  }

  const parsedDeviceId = normalizeDeviceId(parsed.deviceId);
  const config: AgentCliConfig = {
    apiBaseUrl: parsed.apiBaseUrl,
    accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined,
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
    name: parsed.name,
    pollIntervalMs: normalizePollInterval(parsed.pollIntervalMs),
    headPollIntervalMs: normalizeHeadPollInterval(parsed.headPollIntervalMs),
    deviceId: parsedDeviceId ?? randomUUID(),
    dataDir,
  };

  if (!parsedDeviceId) {
    await saveAgentCliConfig(config);
  }

  return config;
}

export async function saveAgentCliConfig(config: AgentCliConfig): Promise<string> {
  await ensureDataDir(config.dataDir);
  const configPath = getConfigPath(config.dataDir);
  const payload = {
    apiBaseUrl: stripTrailingSlash(config.apiBaseUrl),
    accessToken: config.accessToken,
    apiKey: config.apiKey,
    name: config.name,
    pollIntervalMs: normalizePollInterval(config.pollIntervalMs),
    headPollIntervalMs: normalizeHeadPollInterval(config.headPollIntervalMs),
    deviceId: normalizeDeviceId(config.deviceId) ?? randomUUID(),
  };

  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return configPath;
}

export async function removeAgentCliConfig(dataDir: string): Promise<void> {
  await rm(getConfigPath(dataDir), { force: true });
}

export function toBackendOptions(config: AgentCliConfig, logger?: AgentLogger): AgentBackendClientOptions {
  return {
    baseUrl: stripTrailingSlash(config.apiBaseUrl),
    accessToken: config.accessToken,
    logger,
    defaultHeaders: {
      'X-Grepmind-Agent-Name': config.name,
      ...(config.apiKey ? { 'X-Grepmind-Key': config.apiKey } : {}),
    },
  };
}

export async function computeWorkspaceFingerprint(workspacePath: string): Promise<string> {
  const resolved = await realpath(workspacePath);
  const info = await stat(resolved);
  const hash = createHash('sha256');
  hash.update(resolved);
  hash.update(':');
  hash.update(String(info.dev));
  hash.update(':');
  hash.update(String(info.ino));
  return hash.digest('hex');
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizePollInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(Math.trunc(value), 1_000);
}

function normalizeHeadPollInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HEAD_POLL_INTERVAL_MS;
  }

  return Math.max(Math.trunc(value), 500);
}

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
