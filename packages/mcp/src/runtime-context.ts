import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  AgentRuntimeClient,
  ensureAgentReady,
  getAgentAuthStatus,
  resolveAgentDataDir,
  type AgentControlCommand,
  type LocalProjectRecord,
} from '@grepmind/agent-rpc';

const execFileAsync = promisify(execFile);
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;

export interface McpWorkspaceContext {
  workspacePath: string;
  bindingId: number;
  dataDir: string;
  project: LocalProjectRecord;
  agentEntrypointPath: string;
}

interface BundledAgentCommand extends AgentControlCommand {
  entrypointPath: string;
}

let cachedContext: McpWorkspaceContext | null = null;
let cachedRuntimeClient: AgentRuntimeClient | null = null;

export async function prepareMcpRuntime(options: {
  workspacePath: string;
}): Promise<McpWorkspaceContext> {
  const workspacePath = path.resolve(options.workspacePath);
  const dataDir = resolveAgentDataDir(process.env.GREPMIND_AGENT_DATA_DIR);
  const startupTimeoutMs = resolveMcpStartupTimeoutMs();
  const agentCommand = await resolveBundledAgentCommand();
  const hostname = process.env.GREPMIND_AGENT_HOSTNAME?.trim() || undefined;

  const initialAuth = await getAgentAuthStatus(dataDir);
  if (initialAuth.needsLogin && !hostname) {
    throw new Error(
      `Grepmind agent is not authenticated for ${dataDir}. Set GREPMIND_AGENT_HOSTNAME so MCP startup can open the OAuth flow, or pre-login with "${formatAgentLoginCommand(agentCommand.entrypointPath, dataDir, '<host>')}".`,
    );
  }

  try {
    await ensureAgentReady({
      dataDir,
      hostname,
      noOpen: false,
      timeoutMs: startupTimeoutMs,
      command: agentCommand,
    });
  } catch (error) {
    throw normalizeStartupPreparationError(error, {
      workspacePath,
      dataDir,
      startupTimeoutMs,
      agentEntrypointPath: agentCommand.entrypointPath,
      hostname,
    });
  }

  const client = new AgentRuntimeClient(dataDir);
  const project = await resolveOrRegisterWorkspaceProject({
    client,
    workspacePath,
    dataDir,
    agentEntrypointPath: agentCommand.entrypointPath,
    startupTimeoutMs,
  });

  cachedRuntimeClient = client;
  cachedContext = {
    workspacePath,
    bindingId: project.bindingId,
    dataDir,
    project,
    agentEntrypointPath: agentCommand.entrypointPath,
  };

  return cachedContext;
}

export function getMcpWorkspaceContext(): McpWorkspaceContext {
  if (!cachedContext) {
    throw new Error('Grepmind MCP runtime context is not prepared');
  }

  return cachedContext;
}

export function getReadyAgentRuntimeClient(): AgentRuntimeClient {
  if (!cachedRuntimeClient) {
    throw new Error('Grepmind agent runtime client is not prepared');
  }

  return cachedRuntimeClient;
}

export async function resolveBundledAgentCommand(): Promise<BundledAgentCommand> {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(import.meta.url).resolve(
      '@grepmind/agent/package.json',
    );
  } catch (error) {
    throw new Error(
      `Grepmind MCP installation is incomplete: bundled @grepmind/agent package was not found. Reinstall @grepmind/mcp. ${formatError(error)}`,
    );
  }

  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as Partial<{
    bin: Record<string, string> | string;
  }>;
  const bin =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.['grepmind-agent'];

  if (!bin || typeof bin !== 'string') {
    throw new Error(
      'Grepmind MCP installation is incomplete: bundled @grepmind/agent does not declare a grepmind-agent bin. Reinstall @grepmind/mcp.',
    );
  }

  const entrypointPath = path.resolve(packageRoot, bin);
  try {
    await access(entrypointPath);
  } catch (error) {
    throw new Error(
      `Grepmind MCP installation is incomplete: bundled agent entrypoint was not found at ${entrypointPath}. Reinstall @grepmind/mcp. ${formatError(error)}`,
    );
  }

  return {
    command: process.execPath,
    baseArgs: [entrypointPath],
    entrypointPath,
  };
}

export function resolveMcpStartupTimeoutMs(): number {
  const raw = process.env.GREPMIND_MCP_STARTUP_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      'GREPMIND_MCP_STARTUP_TIMEOUT_MS must be a positive integer',
    );
  }

  return value;
}

async function resolveOrRegisterWorkspaceProject(input: {
  client: AgentRuntimeClient;
  workspacePath: string;
  dataDir: string;
  agentEntrypointPath: string;
  startupTimeoutMs: number;
}): Promise<LocalProjectRecord> {
  const workspaceFingerprint = await computeWorkspaceFingerprint(
    input.workspacePath,
  );
  const matchingProject = await findUniqueRegisteredProject({
    client: input.client,
    workspacePath: input.workspacePath,
    workspaceFingerprint,
    dataDir: input.dataDir,
    agentEntrypointPath: input.agentEntrypointPath,
  });

  if (matchingProject) {
    return matchingProject;
  }

  const metadata = await collectWorkspaceRegistrationMetadata({
    workspacePath: input.workspacePath,
    workspaceFingerprint,
    dataDir: input.dataDir,
    agentEntrypointPath: input.agentEntrypointPath,
  });
  const idempotencyMaterial = `${workspaceFingerprint}\0${metadata.remoteUrl}`;
  const idempotencyKey = `mcp-register:${sha256(idempotencyMaterial)}`;

  try {
    const result = await input.client.registerProject(
      {
        ...metadata,
        idempotencyKey,
      },
      { timeoutMs: input.startupTimeoutMs },
    );
    return result.snapshot.project;
  } catch (error) {
    throw new Error(
      `Grepmind MCP could not register workspace ${input.workspacePath}: ${formatError(error)}`,
    );
  }
}

async function findUniqueRegisteredProject(input: {
  client: AgentRuntimeClient;
  workspacePath: string;
  workspaceFingerprint: string;
  dataDir: string;
  agentEntrypointPath: string;
}): Promise<LocalProjectRecord | null> {
  const startupRealpath = await realpath(input.workspacePath);
  const projects = await input.client.listProjects();
  const matches = new Map<number, LocalProjectRecord>();

  for (const project of projects.items) {
    if (
      await matchesRegisteredWorkspace(project, {
        workspacePath: input.workspacePath,
        workspaceRealpath: startupRealpath,
        workspaceFingerprint: input.workspaceFingerprint,
      })
    ) {
      matches.set(project.bindingId, project);
    }
  }

  const uniqueMatches = [...matches.values()];
  if (uniqueMatches.length === 0) {
    return null;
  }
  if (uniqueMatches.length === 1) {
    return uniqueMatches[0]!;
  }

  throw new Error(
    `Grepmind MCP found multiple local project bindings for ${input.workspacePath}: ${uniqueMatches.map((project) => `#${project.bindingId}`).join(', ')}. MCP cannot choose between duplicate bindings; clean them manually with "${formatAgentCleanCommand(input.agentEntrypointPath, input.dataDir, input.workspacePath)}" and retry.`,
  );
}

async function matchesRegisteredWorkspace(
  project: LocalProjectRecord,
  workspace: {
    workspacePath: string;
    workspaceRealpath: string;
    workspaceFingerprint: string;
  },
): Promise<boolean> {
  if (path.resolve(project.workspacePath) === workspace.workspacePath) {
    return true;
  }

  if (project.workspaceFingerprint === workspace.workspaceFingerprint) {
    return true;
  }

  try {
    return (
      (await realpath(project.workspacePath)) === workspace.workspaceRealpath
    );
  } catch {
    return false;
  }
}

async function collectWorkspaceRegistrationMetadata(input: {
  workspacePath: string;
  workspaceFingerprint: string;
  dataDir: string;
  agentEntrypointPath: string;
}): Promise<{
  remoteUrl: string;
  repoFullName?: string;
  defaultBranch?: string;
  displayName: string;
  workspacePath: string;
  workspaceFingerprint: string;
  preferredActiveBranch?: string;
}> {
  let remoteUrl: string;
  try {
    remoteUrl = await resolveWorkspaceRemoteUrl(input.workspacePath);
  } catch (error) {
    throw new Error(
      `Workspace ${input.workspacePath} is not registered and does not have a readable origin remote, so Grepmind MCP cannot auto-register it. Configure origin, then retry MCP startup or run "${formatAgentRegisterCommand(input.agentEntrypointPath, input.dataDir, input.workspacePath)}". ${formatError(error)}`,
    );
  }

  return {
    remoteUrl,
    repoFullName: deriveRepoFullNameFromRemoteUrl(remoteUrl),
    defaultBranch: await resolveWorkspaceDefaultBranch(input.workspacePath),
    displayName: path.basename(input.workspacePath),
    workspacePath: input.workspacePath,
    workspaceFingerprint: input.workspaceFingerprint,
    preferredActiveBranch: await resolveCurrentBranch(input.workspacePath),
  };
}

async function computeWorkspaceFingerprint(
  workspacePath: string,
): Promise<string> {
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

async function resolveWorkspaceRemoteUrl(
  workspacePath: string,
): Promise<string> {
  const remote = await runGit(workspacePath, ['remote', 'get-url', 'origin']);
  if (!remote) {
    throw new Error('git remote get-url origin returned empty output');
  }
  return remote;
}

async function resolveWorkspaceDefaultBranch(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    const remoteHead = await runGit(workspacePath, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    const branch = remoteHead.startsWith('origin/')
      ? remoteHead.slice('origin/'.length)
      : remoteHead;
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function resolveCurrentBranch(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    const branch = await runGit(workspacePath, ['branch', '--show-current']);
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspacePath, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );

  return stdout.trim();
}

function deriveRepoFullNameFromRemoteUrl(
  remoteUrl: string,
): string | undefined {
  const parsed = parseRemoteUrlPath(remoteUrl);
  if (!parsed || parsed.pathSegments.length !== 2) {
    return undefined;
  }

  return parsed.pathSegments.join('/');
}

function parseRemoteUrlPath(
  remoteUrl: string,
): { pathSegments: string[] } | null {
  const raw = remoteUrl.trim();
  const scp = /^(?:[A-Za-z0-9._-]+)@(?<host>[^:/\s]+):(?<path>[^?#\s]+)$/.exec(
    raw,
  );
  if (scp?.groups?.path && !/^\d+\//.test(scp.groups.path)) {
    return normalizeRemotePath(scp.groups.path);
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
    return normalizeRemotePath(url.pathname);
  } catch {
    return null;
  }
}

function normalizeRemotePath(
  pathname: string,
): { pathSegments: string[] } | null {
  const trimmed = pathname.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const withoutGit = trimmed.replace(/\.git$/i, '');
  const pathSegments = withoutGit
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  return pathSegments.length >= 2 ? { pathSegments } : null;
}

function normalizeStartupPreparationError(
  error: unknown,
  context: {
    workspacePath: string;
    dataDir: string;
    startupTimeoutMs: number;
    agentEntrypointPath: string;
    hostname?: string;
  },
): Error {
  const message = formatError(error);
  if (/timed out|timeout|RUNTIME_START_TIMEOUT/i.test(message)) {
    return new Error(
      `Grepmind MCP startup timed out after ${context.startupTimeoutMs}ms while preparing the bundled agent runtime for ${context.workspacePath}. If your MCP client has a short startup timeout, pre-login with "${formatAgentLoginCommand(context.agentEntrypointPath, context.dataDir, context.hostname ?? '<host>')}" and retry. Original error: ${message}`,
    );
  }

  if (/not authenticated|credentials/i.test(message)) {
    return new Error(
      `Grepmind agent authentication is required before MCP can connect. Set GREPMIND_AGENT_HOSTNAME so startup can open OAuth, or pre-login with "${formatAgentLoginCommand(context.agentEntrypointPath, context.dataDir, context.hostname ?? '<host>')}". Original error: ${message}`,
    );
  }

  return new Error(
    `Grepmind MCP could not prepare the bundled agent runtime for ${context.workspacePath}: ${message}`,
  );
}

function formatAgentLoginCommand(
  agentEntrypointPath: string,
  dataDir: string,
  hostname: string,
): string {
  return formatCommand([
    process.execPath,
    agentEntrypointPath,
    'auth',
    'login',
    '--hostname',
    hostname,
    '--data-dir',
    dataDir,
  ]);
}

function formatAgentRegisterCommand(
  agentEntrypointPath: string,
  dataDir: string,
  workspacePath: string,
): string {
  return formatCommand([
    process.execPath,
    agentEntrypointPath,
    'register',
    '--workspace',
    workspacePath,
    '--data-dir',
    dataDir,
  ]);
}

function formatAgentCleanCommand(
  agentEntrypointPath: string,
  dataDir: string,
  workspacePath: string,
): string {
  return formatCommand([
    process.execPath,
    agentEntrypointPath,
    'clean',
    '--workspace',
    workspacePath,
    '--data-dir',
    dataDir,
  ]);
}

function formatCommand(args: string[]): string {
  return args.map(quoteShellArg).join(' ');
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
