import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isNotFound, writeTextFileAtomic } from '../file.js';
import {
  type GeneratedMcpEntry,
  readJsonCommandParts,
  resolveWriteDecision,
} from '../mcp-entry.js';

export interface WriteResult {
  agent: string;
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'would-change' | 'skipped';
  message?: string;
}

export interface JsonMcpWriterInput {
  agent: string;
  agentLabel: string;
  workspaceRoot: string;
  configPath: string;
  generated: GeneratedMcpEntry;
  force: boolean;
  yes: boolean;
  explicit: boolean;
  dryRun: boolean;
  includeType?: boolean;
  promptReplace: (message: string) => Promise<boolean>;
}

export async function writeJsonMcpEntry(
  input: JsonMcpWriterInput,
): Promise<WriteResult> {
  const existing = await readJsonConfig(input.configPath);
  const mcpServers =
    existing.config.mcpServers == null
      ? {}
      : assertRecord(existing.config.mcpServers, input.configPath, 'mcpServers');
  const existingEntry = mcpServers.grepmind;
  const decision = await resolveWriteDecision({
    agentLabel: input.agentLabel,
    configPath: input.configPath,
    existingEntryPresent: Object.hasOwn(mcpServers, 'grepmind'),
    existingCommand: readJsonCommandParts(existingEntry),
    generated: input.generated,
    force: input.force,
    yes: input.yes,
    explicit: input.explicit,
    canPrompt: !input.dryRun && !input.yes,
    promptReplace: input.promptReplace,
  }).catch((error) => {
    if (input.dryRun) {
      return null;
    }
    throw error;
  });

  if (decision == null) {
    return {
      agent: input.agent,
      path: input.configPath,
      status: 'skipped',
      message:
        'existing grepmind entry is unrecognized; rerun without --dry-run to confirm or pass --force',
    };
  }

  const nextConfig = {
    ...existing.config,
    mcpServers: {
      ...mcpServers,
      grepmind: buildJsonMcpEntry(input, decision),
    },
  };
  const nextRaw = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (existing.raw === nextRaw) {
    return { agent: input.agent, path: input.configPath, status: 'unchanged' };
  }
  if (input.dryRun) {
    return { agent: input.agent, path: input.configPath, status: 'would-change' };
  }

  await writeTextFileAtomic({
    root: input.workspaceRoot,
    targetPath: input.configPath,
    content: nextRaw,
  });

  return {
    agent: input.agent,
    path: input.configPath,
    status: existing.exists ? 'updated' : 'created',
    message: decision.preservedCommand ? 'preserved existing command and args' : undefined,
  };
}

function buildJsonMcpEntry(
  input: JsonMcpWriterInput,
  decision: { command: string; args: string[] },
): Record<string, unknown> {
  return {
    ...(input.includeType ? { type: 'stdio' } : {}),
    command: decision.command,
    args: decision.args,
    env: input.generated.env,
  };
}

async function readJsonConfig(configPath: string): Promise<{
  exists: boolean;
  config: Record<string, unknown>;
  raw: string | null;
}> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return {
      exists: true,
      config: parseJsonObject(raw, configPath),
      raw,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { exists: false, config: {}, raw: null };
    }
    throw error;
  }
}

function parseJsonObject(raw: string, configPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return assertRecord(parsed, configPath, 'top-level value');
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertRecord(
  value: unknown,
  configPath: string,
  label: string,
): Record<string, unknown> {
  if (typeof value === 'object' && value != null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${configPath}: ${label} must be an object`);
}
