export interface GeneratedMcpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  startupTimeoutMs: number;
  toolTimeoutSec: number;
}

export interface ExistingCommandParts {
  command?: string;
  args?: string[];
  commandArray?: string[];
}

export interface WriteDecision {
  command: string;
  args: string[];
  preservedCommand: boolean;
}

const DEFAULT_PROMPT_REFINER_TIMEOUT_MS = 45_000;
const DEFAULT_CONTEXT_LAYER_TIMEOUT_MS = 180_000;
const DEFAULT_CONTEXT_LAYER_TOOL_TIMEOUT_BUFFER_SEC = 30;
const DEFAULT_MCP_TOOL_TIMEOUT_SEC =
  Math.ceil(DEFAULT_PROMPT_REFINER_TIMEOUT_MS / 1000) +
  Math.ceil(DEFAULT_CONTEXT_LAYER_TIMEOUT_MS / 1000) +
  DEFAULT_CONTEXT_LAYER_TOOL_TIMEOUT_BUFFER_SEC;

export function createGeneratedMcpEntry(input: {
  hostname: string;
  workspaceRoot: string;
  dataDir?: string;
  packageSpec: string;
  startupTimeoutMs: number;
}): GeneratedMcpEntry {
  const env: Record<string, string> = {
    GREPMIND_AGENT_HOSTNAME: input.hostname,
    GREPMIND_MCP_STARTUP_TIMEOUT_MS: String(input.startupTimeoutMs),
  };
  if (input.dataDir != null) {
    env.GREPMIND_AGENT_DATA_DIR = input.dataDir;
  }

  return {
    command: 'npx',
    args: ['-y', input.packageSpec],
    env,
    cwd: input.workspaceRoot,
    startupTimeoutMs: input.startupTimeoutMs,
    toolTimeoutSec: DEFAULT_MCP_TOOL_TIMEOUT_SEC,
  };
}

export async function resolveWriteDecision(input: {
  agentLabel: string;
  configPath: string;
  existingEntryPresent: boolean;
  existingCommand?: ExistingCommandParts;
  generated: GeneratedMcpEntry;
  force: boolean;
  yes: boolean;
  explicit: boolean;
  canPrompt: boolean;
  promptReplace: (message: string) => Promise<boolean>;
}): Promise<WriteDecision> {
  if (!input.existingEntryPresent) {
    return {
      command: input.generated.command,
      args: input.generated.args,
      preservedCommand: false,
    };
  }

  if (
    input.existingCommand != null &&
    !input.force &&
    isRecognizedGrepmindCommand(input.existingCommand)
  ) {
    return {
      command: input.existingCommand.command ?? input.generated.command,
      args: input.existingCommand.args ?? input.generated.args,
      preservedCommand: true,
    };
  }

  if (input.force || (input.yes && input.explicit)) {
    return {
      command: input.generated.command,
      args: input.generated.args,
      preservedCommand: false,
    };
  }

  if (input.canPrompt) {
    const replace = await input.promptReplace(
      `${input.agentLabel} config already has an unrecognized grepmind MCP entry at ${input.configPath}. Replace it`,
    );
    if (replace) {
      return {
        command: input.generated.command,
        args: input.generated.args,
        preservedCommand: false,
      };
    }
    throw new Error(`${input.agentLabel} config was left unchanged`);
  }

  throw new Error(
    `${input.agentLabel} config has an unrecognized grepmind MCP entry at ${input.configPath}. Re-run with --force to replace it.`,
  );
}

export function isRecognizedGrepmindCommand(
  command: ExistingCommandParts,
): boolean {
  if (command.commandArray != null) {
    return command.commandArray.some(isGrepmindMcpToken);
  }

  if (command.command === 'grepmind-mcp') {
    return true;
  }

  if (
    command.command === 'npx' &&
    command.args?.some((token) => token.startsWith('@grepmind/mcp'))
  ) {
    return true;
  }

  if (
    command.command === 'node' &&
    command.args?.some((token) =>
      token.replaceAll('\\', '/').endsWith('packages/mcp/dist/index.js'),
    )
  ) {
    return true;
  }

  return false;
}

export function readJsonCommandParts(
  entry: unknown,
): ExistingCommandParts | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((value): value is string => typeof value === 'string')
    : undefined;
  const commandArray = Array.isArray(entry.command)
    ? entry.command.filter(
        (value): value is string => typeof value === 'string',
      )
    : undefined;

  if (command == null && commandArray == null) {
    return undefined;
  }
  return { command, args, commandArray };
}

function isGrepmindMcpToken(value: string): boolean {
  return (
    value === '@grepmind/mcp' ||
    value.startsWith('@grepmind/mcp') ||
    value === 'grepmind-mcp'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}
