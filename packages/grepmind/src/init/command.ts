/* eslint-disable max-lines */

import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  ensureAgentReady,
  ensureWorkspaceRegistered,
  getAgentAuthStatus,
  loginAgent,
  resolveAgentDataDir,
  type LocalProjectRecord,
} from '@grepmind/agent-rpc';

import { resolveBundledAgentCommand } from './agent-command.js';
import {
  formatAgentName,
  supportedInitAgents,
  type InitAgentName,
} from './agents.js';
import { parseInitArgs, type InitArgs } from './args.js';
import { detectInitAgents, type DetectionResult } from './detect.js';
import { resolveGitWorkspaceRoot } from './git.js';
import { hostnamesEqual, resolveInitHostname } from './hostname.js';
import {
  createGeneratedMcpEntry,
  type GeneratedMcpEntry,
} from './mcp-entry.js';
import { resolveMcpPackageSpec } from './mcp-package.js';
import {
  readProjectConfig,
  writeProjectConfig,
  type ConfigWriteResult,
  type ProjectConfigReadResult,
} from './project-config.js';
import { writeClaudeConfig } from './writers/claude.js';
import { writeCodexConfig } from './writers/codex.js';
import { writeCursorConfig } from './writers/cursor.js';
import type { WriteResult } from './writers/json-config.js';

interface InitRuntimeResult {
  dataDir: string;
  project: LocalProjectRecord;
}

export async function runInitCommand(args: string[]): Promise<void> {
  const parsed = parseInitArgs(args);
  if (parsed.help) {
    printInitHelp();
    return;
  }

  const workspaceRoot = await resolveGitWorkspaceRoot();
  const existingProjectConfig = await readProjectConfig(workspaceRoot);
  const hostname = resolveInitHostname({
    flagHostname: parsed.hostname,
    existingHostname: existingProjectConfig.hostname,
  });
  await confirmHostnameChange({
    parsed,
    existingProjectConfig,
    hostname,
  });

  const detection = await detectInitAgents(workspaceRoot);
  const selectedAgents = await selectAgents(parsed, detection);
  const dataDir =
    parsed.dataDir == null ? undefined : resolveAgentDataDir(parsed.dataDir);
  const mcpPackage = resolveMcpPackageSpec(parsed.mcpPackage);
  const generated = createGeneratedMcpEntry({
    hostname,
    workspaceRoot,
    dataDir,
    packageSpec: mcpPackage,
    startupTimeoutMs: parsed.mcpStartupTimeoutMs,
  });

  const runtime = parsed.dryRun
    ? null
    : await prepareRuntimeAndRegisterWorkspace({
        dataDir,
        hostname,
        noOpen: parsed.noOpen,
        yes: parsed.yes,
        startupTimeoutMs: parsed.mcpStartupTimeoutMs,
        workspaceRoot,
      });

  const projectResult = await writeProjectConfig({
    workspaceRoot,
    existing: existingProjectConfig,
    hostname,
    mcpPackage,
    startupTimeoutMs: parsed.mcpStartupTimeoutMs,
    dryRun: parsed.dryRun,
  });
  const writerResults = await writeSelectedMcpConfigs({
    parsed,
    workspaceRoot,
    selectedAgents,
    generated,
  });

  printSummary({
    dryRun: parsed.dryRun,
    workspaceRoot,
    hostname,
    detection,
    selectedAgents,
    projectResult,
    writerResults,
    generated,
    runtime,
  });
}

export function printInitHelp(): void {
  process.stdout.write(
    [
      'grepmind init',
      '',
      'Usage:',
      '  grepmind init [--hostname <host>] [--codex|--claude|--cursor] [--yes]',
      '',
      'Options:',
      '  --hostname <host>              Grepmind backend host, default app.grepmind.ai',
      '  --codex                        Configure .codex/config.toml',
      '  --claude                       Configure .mcp.json',
      '  --cursor                       Configure .cursor/mcp.json',
      '  --all-detected                 Configure all detected supported clients',
      '  -y, --yes                      Do not ask terminal prompt questions',
      '  --no-open                      Do not automatically open browser during OAuth',
      '  --data-dir <dir>               Grepmind agent data directory',
      '  --mcp-package <pkg>            Override MCP package spec',
      '  --mcp-startup-timeout-ms <ms>  MCP startup timeout, default 120000',
      '  --force                        Replace existing grepmind command and args',
      '  --dry-run                      Show planned writes without side effects',
      '  --project                      Compatibility no-op',
      '  --global                       Unsupported; init only supports project scope',
      '  -h, --help                     Show this help',
      '',
      'Rules:',
      '  Multiple explicit client flags are allowed.',
      '  --all-detected cannot be combined with explicit client flags.',
      '  --yes --no-open fails if OAuth login or account selection is required.',
      '  Existing recognized Grepmind MCP commands are preserved unless --force is passed.',
      '',
    ].join('\n'),
  );
}

async function confirmHostnameChange(input: {
  parsed: InitArgs;
  existingProjectConfig: ProjectConfigReadResult;
  hostname: string;
}): Promise<void> {
  const existingHostname = input.existingProjectConfig.hostname;
  if (
    input.parsed.dryRun ||
    input.parsed.yes ||
    input.parsed.hostname == null ||
    existingHostname == null ||
    hostnamesEqual(existingHostname, input.hostname)
  ) {
    return;
  }

  const confirmed = await promptBoolean(
    `.grepmind.json uses ${existingHostname}. Update it to ${input.hostname}`,
    false,
  );
  if (!confirmed) {
    throw new Error('Hostname update was not confirmed');
  }
}

async function selectAgents(
  parsed: InitArgs,
  detection: DetectionResult,
): Promise<InitAgentName[]> {
  if (parsed.selectedAgents.size > 0) {
    return [...parsed.selectedAgents];
  }

  if (parsed.allDetected || parsed.yes) {
    if (detection.detectedSupported.length === 0) {
      throw new Error(
        'No supported project-local MCP clients were detected. Pass --codex, --claude, or --cursor explicitly.',
      );
    }
    return detection.detectedSupported;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No MCP client could be selected without a prompt. Pass --codex, --claude, or --cursor.',
    );
  }

  const candidates =
    detection.detectedSupported.length > 0
      ? detection.detectedSupported
      : [...supportedInitAgents];
  const defaults = detection.detectedSupported;
  return promptAgentSelection(candidates, defaults);
}

async function prepareRuntimeAndRegisterWorkspace(input: {
  dataDir?: string;
  hostname: string;
  noOpen: boolean;
  yes: boolean;
  startupTimeoutMs: number;
  workspaceRoot: string;
}): Promise<InitRuntimeResult> {
  const dataDir = resolveAgentDataDir(input.dataDir);
  const agentCommand = await resolveBundledAgentCommand();
  const initialAuth = await getAgentAuthStatus(dataDir);
  const hostMismatch =
    initialAuth.host != null &&
    !hostnamesEqual(initialAuth.host, input.hostname);

  if (input.yes && input.noOpen && (initialAuth.needsLogin || hostMismatch)) {
    const currentHost = initialAuth.host ?? 'not logged in';
    throw new Error(
      `Grepmind agent auth is required for ${input.hostname}, but --yes --no-open cannot open a browser or wait for account selection. Current agent host: ${currentHost}. Run "grepmind auth login --hostname ${input.hostname}" first, then retry.`,
    );
  }

  if (hostMismatch) {
    const currentHost = initialAuth.host!;
    if (!input.yes) {
      const confirmed = await promptBoolean(
        `Agent data dir ${dataDir} is logged in for ${currentHost}. Run OAuth login for ${input.hostname}`,
        true,
      );
      if (!confirmed) {
        throw new Error(
          'OAuth login for the selected hostname was not confirmed',
        );
      }
    }
    await loginAgent({
      dataDir,
      hostname: input.hostname,
      noOpen: input.noOpen,
      timeoutMs: input.startupTimeoutMs,
      command: agentCommand,
    });
  }

  try {
    await ensureAgentReady({
      dataDir,
      hostname: input.hostname,
      noOpen: input.noOpen,
      timeoutMs: input.startupTimeoutMs,
      command: agentCommand,
    });
  } catch (error) {
    throw normalizeRuntimeError(error, input);
  }

  const client = new AgentRuntimeClient(dataDir);
  const project = await ensureWorkspaceRegistered({
    client,
    workspacePath: input.workspaceRoot,
    idempotencyPrefix: 'init-register',
    timeoutMs: input.startupTimeoutMs,
  });

  return { dataDir, project };
}

async function writeSelectedMcpConfigs(input: {
  parsed: InitArgs;
  workspaceRoot: string;
  selectedAgents: InitAgentName[];
  generated: GeneratedMcpEntry;
}): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const explicit = input.parsed.selectedAgents;
  for (const agent of input.selectedAgents) {
    const common = {
      workspaceRoot: input.workspaceRoot,
      generated: input.generated,
      force: input.parsed.force,
      yes: input.parsed.yes,
      explicit: explicit.has(agent),
      dryRun: input.parsed.dryRun,
      promptReplace: promptReplaceMcpEntry,
    };
    if (agent === 'codex') {
      results.push(await writeCodexConfig(common));
    } else if (agent === 'claude') {
      results.push(await writeClaudeConfig(common));
    } else {
      results.push(await writeCursorConfig(common));
    }
  }
  return results;
}

function printSummary(input: {
  dryRun: boolean;
  workspaceRoot: string;
  hostname: string;
  detection: DetectionResult;
  selectedAgents: InitAgentName[];
  projectResult: ConfigWriteResult;
  writerResults: WriteResult[];
  generated: GeneratedMcpEntry;
  runtime: InitRuntimeResult | null;
}): void {
  const lines = [
    input.dryRun ? 'Grepmind init dry run' : 'Grepmind init complete',
    `Workspace: ${input.workspaceRoot}`,
    `Hostname: ${input.hostname}`,
    `Selected clients: ${formatAgentList(input.selectedAgents)}`,
  ];

  if (input.detection.detectedUnsupported.length > 0) {
    lines.push(
      `Detected unsupported clients: ${input.detection.detectedUnsupported.map(formatAgentName).join(', ')}`,
    );
  }
  if (input.runtime != null) {
    lines.push(`Agent data dir: ${input.runtime.dataDir}`);
    lines.push(`Workspace binding: #${input.runtime.project.bindingId}`);
  }

  lines.push('', input.dryRun ? 'Planned files:' : 'Files:');
  lines.push(
    `  ${relative(input.workspaceRoot, input.projectResult.path)}: ${input.projectResult.status}`,
  );
  for (const result of input.writerResults) {
    const message = result.message == null ? '' : ` (${result.message})`;
    lines.push(
      `  ${relative(input.workspaceRoot, result.path)}: ${result.status}${message}`,
    );
  }

  if (input.dryRun) {
    lines.push(
      '',
      'Normalized MCP entry:',
      `  command: ${input.generated.command}`,
      `  args: ${JSON.stringify(input.generated.args)}`,
      `  env: ${JSON.stringify(input.generated.env)}`,
      `  startupTimeoutMs: ${input.generated.startupTimeoutMs}`,
    );
  }

  lines.push('', 'Next steps:');
  if (input.selectedAgents.includes('codex')) {
    lines.push('  Codex: trust this project before using project MCP config.');
  }
  if (input.selectedAgents.includes('claude')) {
    lines.push(
      '  Claude Code may ask to approve the project-scoped MCP server.',
    );
  }
  if (input.selectedAgents.includes('cursor')) {
    lines.push(
      '  Cursor: reload the workspace if the MCP server is already running.',
    );
  }
  lines.push('  Restart or reload selected MCP clients after config changes.');

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function promptAgentSelection(
  candidates: InitAgentName[],
  defaults: InitAgentName[],
): Promise<InitAgentName[]> {
  process.stdout.write('MCP clients:\n');
  for (const agent of candidates) {
    const suffix = defaults.includes(agent) ? ' (detected)' : '';
    process.stdout.write(`  ${agent} - ${formatAgentName(agent)}${suffix}\n`);
  }

  const defaultValue = defaults.join(',');
  const answer = await promptText(
    'Configure clients (comma-separated, or all)',
    defaultValue,
  );
  const selected =
    answer.trim().toLowerCase() === 'all'
      ? candidates
      : answer
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .map((value) => {
            if (!supportedInitAgents.includes(value as InitAgentName)) {
              throw new Error(`Unsupported client selection: ${value}`);
            }
            return value as InitAgentName;
          });

  const uniqueSelected = [...new Set(selected)];
  if (uniqueSelected.length === 0) {
    throw new Error('Select at least one MCP client');
  }
  return uniqueSelected;
}

async function promptText(
  label: string,
  defaultValue?: string,
): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} requires an interactive TTY`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix =
      defaultValue == null || defaultValue === ''
        ? ': '
        : ` [${defaultValue}]: `;
    const answer = await rl.question(`${label}${suffix}`);
    return answer === '' && defaultValue != null ? defaultValue : answer;
  } finally {
    rl.close();
  }
}

async function promptBoolean(
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const defaultText = defaultValue ? 'yes' : 'no';
  while (true) {
    const answer = (
      await promptText(`${label} (yes/no)`, defaultText)
    ).toLowerCase();
    if (answer === 'yes' || answer === 'y' || answer === 'true') {
      return true;
    }
    if (answer === 'no' || answer === 'n' || answer === 'false') {
      return false;
    }
    process.stdout.write('Answer yes or no.\n');
  }
}

function promptReplaceMcpEntry(message: string): Promise<boolean> {
  return promptBoolean(message, false);
}

function normalizeRuntimeError(
  error: unknown,
  context: {
    hostname: string;
    noOpen: boolean;
    startupTimeoutMs: number;
    workspaceRoot: string;
  },
): Error {
  if (error instanceof AgentRuntimeClientError) {
    switch (error.code) {
      case 'AUTH_AGENT_CREDENTIAL_REQUIRED':
      case 'AUTH_OAUTH_TOKEN_REQUIRED':
      case 'AUTH_USER_SUBJECT_REQUIRED':
      case 'AGENT_ACCOUNT_SESSION_REQUIRED':
      case 'AGENT_ACCOUNT_SESSION_EXPIRED':
      case 'AGENT_ACCOUNT_SESSION_REVOKED':
      case 'AGENT_UPGRADE_REQUIRED':
        return new Error(
          `Grepmind agent authentication and account selection are required for ${context.hostname}. Run "grepmind auth login --hostname ${context.hostname}" and retry.`,
        );
      case 'TIMEOUT':
        return new Error(
          `Grepmind agent runtime timed out after ${context.startupTimeoutMs}ms while preparing ${context.workspaceRoot}.`,
        );
      default:
        break;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout|RUNTIME_START_TIMEOUT/i.test(message)) {
    return new Error(
      `Grepmind agent runtime timed out after ${context.startupTimeoutMs}ms while preparing ${context.workspaceRoot}. Original error: ${message}`,
    );
  }
  if (
    context.noOpen &&
    /AUTH_CALLBACK_TIMEOUT|account session|not authenticated/i.test(message)
  ) {
    return new Error(
      `Grepmind agent auth is required for ${context.hostname}, but --no-open did not complete OAuth/account selection. Run "grepmind auth login --hostname ${context.hostname}" first, then retry.`,
    );
  }

  return new Error(
    `Grepmind init could not prepare the agent runtime: ${message}`,
  );
}

function formatAgentList(agents: InitAgentName[]): string {
  return agents.map(formatAgentName).join(', ');
}

function relative(root: string, target: string): string {
  const value = path.relative(root, target);
  return value === '' ? path.basename(target) : value;
}
