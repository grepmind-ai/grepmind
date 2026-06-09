import type { InitAgentName } from './agents.js';

export interface InitArgs {
  help: boolean;
  hostname?: string;
  selectedAgents: Set<InitAgentName>;
  allDetected: boolean;
  yes: boolean;
  noOpen: boolean;
  dataDir?: string;
  mcpPackage?: string;
  mcpStartupTimeoutMs: number;
  force: boolean;
  dryRun: boolean;
  project: boolean;
}

type ParsedArgs = {
  positionals: string[];
  options: Map<string, string[]>;
  booleans: Set<string>;
};

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;

const booleanOptions = new Set([
  'all-detected',
  'claude',
  'codex',
  'cursor',
  'dry-run',
  'force',
  'gemini',
  'global',
  'help',
  'no-open',
  'opencode',
  'project',
  'yes',
]);

const valueOptions = new Set([
  'data-dir',
  'hostname',
  'mcp-package',
  'mcp-startup-timeout-ms',
]);

export function parseInitArgs(args: string[]): InitArgs {
  const parsed = parseArgs(args);
  const help = hasBoolean(parsed, 'help');
  if (help) {
    return {
      help,
      selectedAgents: new Set(),
      allDetected: false,
      yes: false,
      noOpen: false,
      mcpStartupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      force: false,
      dryRun: false,
      project: false,
    };
  }

  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
  }
  if (hasBoolean(parsed, 'global')) {
    throw new Error('grepmind init only supports project scope');
  }
  if (hasBoolean(parsed, 'opencode')) {
    throw new Error('OpenCode support is planned for phase 2');
  }
  if (hasBoolean(parsed, 'gemini')) {
    throw new Error('Gemini CLI support is planned for phase 2');
  }

  const selectedAgents = new Set<InitAgentName>();
  for (const agent of ['codex', 'claude', 'cursor'] as const) {
    if (hasBoolean(parsed, agent)) {
      selectedAgents.add(agent);
    }
  }

  const allDetected = hasBoolean(parsed, 'all-detected');
  if (allDetected && selectedAgents.size > 0) {
    throw new Error(
      '--all-detected cannot be combined with explicit client flags',
    );
  }

  return {
    help,
    hostname: getOption(parsed, 'hostname'),
    selectedAgents,
    allDetected,
    yes: hasBoolean(parsed, 'yes'),
    noOpen: hasBoolean(parsed, 'no-open'),
    dataDir: getOption(parsed, 'data-dir'),
    mcpPackage: getOption(parsed, 'mcp-package'),
    mcpStartupTimeoutMs: getPositiveIntegerOption(
      parsed,
      'mcp-startup-timeout-ms',
      DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    ),
    force: hasBoolean(parsed, 'force'),
    dryRun: hasBoolean(parsed, 'dry-run'),
    project: hasBoolean(parsed, 'project'),
  };
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-y') {
      booleans.add('yes');
      continue;
    }
    if (arg === '-h') {
      booleans.add('help');
      continue;
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) {
        throw new Error(`Unknown option: ${arg}`);
      }
      positionals.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const rawName =
      equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    if (!booleanOptions.has(rawName) && !valueOptions.has(rawName)) {
      throw new Error(`Unknown option: --${rawName}`);
    }

    if (booleanOptions.has(rawName)) {
      if (equalsIndex !== -1) {
        throw new Error(`Option --${rawName} does not take a value`);
      }
      booleans.add(rawName);
      continue;
    }

    const value =
      equalsIndex === -1 ? args[index + 1] : arg.slice(equalsIndex + 1);
    if (value == null || value.startsWith('--')) {
      throw new Error(`Option --${rawName} requires a value`);
    }
    if (equalsIndex === -1) {
      index += 1;
    }
    const values = options.get(rawName) ?? [];
    values.push(value);
    options.set(rawName, values);
  }

  return { positionals, options, booleans };
}

function getPositiveIntegerOption(
  parsed: ParsedArgs,
  name: string,
  defaultValue: number,
): number {
  const value = getOption(parsed, name);
  if (value == null) {
    return defaultValue;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsedValue;
}

function getOption(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.options.get(name);
  if (values == null) {
    return undefined;
  }
  if (values.length !== 1) {
    throw new Error(`Option --${name} can be provided only once`);
  }
  return values[0];
}

function hasBoolean(parsed: ParsedArgs, name: string): boolean {
  return parsed.booleans.has(name);
}
