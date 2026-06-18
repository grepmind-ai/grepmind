import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  ensureAgentReady,
  ensureWorkspaceRegistered,
  resolveAgentDataDir,
  type AgentControlCommand,
  type LocalProjectRecord,
} from '@grepmind/agent-rpc';

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
let runtimePreparationPromise: Promise<McpWorkspaceContext> | null = null;

export async function prepareMcpRuntime(options: {
  workspacePath: string;
}): Promise<McpWorkspaceContext> {
  const workspacePath = path.resolve(options.workspacePath);
  const dataDir = resolveAgentDataDir(process.env.GREPMIND_AGENT_DATA_DIR);
  const startupTimeoutMs = resolveMcpStartupTimeoutMs();
  const agentCommand = await resolveBundledAgentCommand();
  const hostname = process.env.GREPMIND_AGENT_HOSTNAME?.trim() || undefined;

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
  const project = await ensureWorkspaceRegistered({
    client,
    workspacePath,
    idempotencyPrefix: 'mcp-register',
    timeoutMs: startupTimeoutMs,
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

export function startMcpRuntimePreparation(options: {
  workspacePath: string;
}): Promise<McpWorkspaceContext> {
  if (!runtimePreparationPromise) {
    runtimePreparationPromise = prepareMcpRuntime(options);
    void runtimePreparationPromise.catch((error) => {
      console.error(
        'Grepmind MCP runtime preparation failed:',
        formatError(error),
      );
    });
  }

  return runtimePreparationPromise;
}

export async function ensureMcpRuntimePrepared(): Promise<McpWorkspaceContext> {
  if (cachedContext) {
    return cachedContext;
  }

  if (!runtimePreparationPromise) {
    throw new Error('Grepmind MCP runtime preparation has not started');
  }

  return runtimePreparationPromise;
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
  if (error instanceof AgentRuntimeClientError) {
    const stableError = normalizeStableStartupError(error, context);
    if (stableError) {
      return stableError;
    }
  }

  const message = formatError(error);
  if (/timed out|timeout|RUNTIME_START_TIMEOUT/i.test(message)) {
    return new Error(
      `Grepmind MCP startup timed out after ${context.startupTimeoutMs}ms while preparing the bundled agent runtime for ${context.workspacePath}. If your MCP client has a short startup timeout, pre-login with "${formatAgentLoginCommand(context.agentEntrypointPath, context.dataDir, context.hostname ?? '<host>')}" and retry. Original error: ${message}`,
    );
  }

  if (
    /not authenticated|credentials|account session|AGENT_ACCOUNT_SESSION/i.test(
      message,
    )
  ) {
    return new Error(
      `Grepmind agent authentication and account selection are required before MCP can connect. Set GREPMIND_AGENT_HOSTNAME so startup can open OAuth/account selection, or pre-login with "${formatAgentLoginCommand(context.agentEntrypointPath, context.dataDir, context.hostname ?? '<host>')}". Original error: ${message}`,
    );
  }

  return new Error(
    `Grepmind MCP could not prepare the bundled agent runtime for ${context.workspacePath}: ${message}`,
  );
}

function normalizeStableStartupError(
  error: AgentRuntimeClientError,
  context: {
    workspacePath: string;
    dataDir: string;
    startupTimeoutMs: number;
    agentEntrypointPath: string;
    hostname?: string;
  },
): Error | null {
  switch (error.code) {
    case 'AUTH_AGENT_CREDENTIAL_REQUIRED':
    case 'AUTH_OAUTH_TOKEN_REQUIRED':
    case 'AUTH_USER_SUBJECT_REQUIRED':
    case 'AGENT_ACCOUNT_SESSION_REQUIRED':
    case 'AGENT_ACCOUNT_SESSION_EXPIRED':
    case 'AGENT_ACCOUNT_SESSION_REVOKED':
    case 'AGENT_UPGRADE_REQUIRED':
      return new Error(
        `Grepmind agent authentication and account selection are required before MCP can connect. Set GREPMIND_AGENT_HOSTNAME so startup can open OAuth/account selection, or pre-login with "${formatAgentLoginCommand(context.agentEntrypointPath, context.dataDir, context.hostname ?? '<host>')}".`,
      );
    case 'ACCOUNT_SUSPENDED':
      return new Error(
        'The selected Grepmind account is not active. Contact support or select another account before starting MCP.',
      );
    case 'PLAN_REQUIRED':
      return new Error(
        'The selected Grepmind account needs an active plan before MCP can use search. Open the Grepmind app, select a plan, then restart MCP.',
      );
    case 'PLAN_INACTIVE':
      return new Error(
        'The selected Grepmind account plan is not active. Renew the plan or contact support, then restart MCP.',
      );
    case 'RUNTIME_BACKPRESSURE':
    case 'RETRYABLE_BACKEND_ERROR':
      return new Error(
        `Grepmind backend is temporarily unavailable while preparing MCP for ${context.workspacePath}. Retry shortly.`,
      );
    default:
      return null;
  }
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

function formatCommand(args: string[]): string {
  return args.map(quoteShellArg).join(' ');
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
