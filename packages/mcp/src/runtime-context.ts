import path from 'node:path';
import process from 'node:process';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  ensureWorkspaceRegistered,
  isRuntimeUnavailableError,
  resolveAgentDataDir,
  type LocalProjectRecord,
} from '@grepmind/agent-rpc';

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;

export interface McpWorkspaceContext {
  workspacePath: string;
  bindingId: number;
  dataDir: string;
  project: LocalProjectRecord;
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
  const client = new AgentRuntimeClient(dataDir);

  try {
    await client.ping();
  } catch (error) {
    throw normalizeStartupPreparationError(error, {
      workspacePath,
      dataDir,
      startupTimeoutMs,
    });
  }

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
  },
): Error {
  if (isRuntimeUnavailableError(error)) {
    return new Error(
      `Grepmind agent runtime is not running for ${context.dataDir}. Start it before starting MCP with "${formatAgentRunCommand(context.dataDir)}". MCP no longer starts the agent runtime automatically.`,
    );
  }

  if (error instanceof AgentRuntimeClientError) {
    const stableError = normalizeStableStartupError(error, context);
    if (stableError) {
      return stableError;
    }
  }

  const message = formatError(error);
  if (/timed out|timeout|RUNTIME_START_TIMEOUT/i.test(message)) {
    return new Error(
      `Grepmind MCP startup timed out after ${context.startupTimeoutMs}ms while connecting to the agent runtime for ${context.workspacePath}. Start the agent before starting MCP with "${formatAgentRunCommand(context.dataDir)}". Original error: ${message}`,
    );
  }

  if (
    /not authenticated|credentials|account session|AGENT_ACCOUNT_SESSION/i.test(
      message,
    )
  ) {
    return new Error(
      `Grepmind agent authentication and account selection are required before MCP can connect. Run "grepmind agent auth login --hostname <host> --data-dir ${quoteShellArg(context.dataDir)}" before starting the agent and MCP. Original error: ${message}`,
    );
  }

  return new Error(
    `Grepmind MCP could not connect to the agent runtime for ${context.workspacePath}: ${message}`,
  );
}

function normalizeStableStartupError(
  error: AgentRuntimeClientError,
  context: {
    workspacePath: string;
    dataDir: string;
    startupTimeoutMs: number;
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
        `Grepmind agent authentication and account selection are required before MCP can connect. Run "grepmind agent auth login --hostname <host> --data-dir ${quoteShellArg(context.dataDir)}" before starting the agent and MCP.`,
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

function formatAgentRunCommand(dataDir: string): string {
  return formatCommand([
    'grepmind',
    'agent',
    'run',
    '--detach',
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
