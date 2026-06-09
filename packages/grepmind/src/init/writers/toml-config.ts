import { readFile } from 'node:fs/promises';

import { isNotFound, writeTextFileAtomic } from '../file.js';
import type { ExistingCommandParts } from '../mcp-entry.js';
import type { WriteResult } from './json-config.js';

const GREPMIND_ROOT_SECTION = 'mcp_servers.grepmind';

export interface TomlBlockWriteInput {
  agent: string;
  workspaceRoot: string;
  configPath: string;
  block: string;
  dryRun: boolean;
}

export interface TomlBlockReadResult {
  exists: boolean;
  raw: string | null;
  block: string | null;
}

export async function readGrepmindTomlBlock(
  configPath: string,
): Promise<TomlBlockReadResult> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return {
      exists: true,
      raw,
      block: findGrepmindBlock(raw, configPath)?.block ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { exists: false, raw: null, block: null };
    }
    throw error;
  }
}

export async function writeGrepmindTomlBlock(
  input: TomlBlockWriteInput,
): Promise<WriteResult> {
  const existing = await readGrepmindTomlBlock(input.configPath);
  const nextRaw = replaceGrepmindBlock(
    existing.raw ?? '',
    input.block,
    input.configPath,
  );

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
  };
}

export function parseTomlCommandParts(
  block: string | null,
): ExistingCommandParts | undefined {
  if (block == null) {
    return undefined;
  }
  const rootLines = rootSectionLines(block);
  const command = parseTomlStringAssignment(rootLines, 'command');
  const args = parseTomlStringArrayAssignment(rootLines, 'args');
  if (command == null) {
    return undefined;
  }
  return { command, args };
}

export function renderCodexGrepmindBlock(input: {
  command: string;
  args: string[];
  cwd: string;
  startupTimeoutMs: number;
  toolTimeoutSec: number;
  env: Record<string, string>;
}): string {
  const startupTimeoutSec = Math.ceil(input.startupTimeoutMs / 1000);
  return [
    '[mcp_servers.grepmind]',
    `command = ${tomlString(input.command)}`,
    `args = [${input.args.map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(input.cwd)}`,
    `startup_timeout_sec = ${startupTimeoutSec}`,
    `tool_timeout_sec = ${input.toolTimeoutSec}`,
    '',
    '[mcp_servers.grepmind.env]',
    ...Object.entries(input.env).map(
      ([key, value]) => `${key} = ${tomlString(value)}`,
    ),
    '',
  ].join('\n');
}

function replaceGrepmindBlock(
  raw: string,
  block: string,
  configPath: string,
): string {
  const found = findGrepmindBlock(raw, configPath);
  if (!found) {
    if (raw.length === 0) {
      return block;
    }
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`;
    return `${prefix}\n${block}`;
  }

  return `${raw.slice(0, found.start)}${block}${raw.slice(found.end)}`;
}

function findGrepmindBlock(
  raw: string,
  configPath: string,
): { start: number; end: number; block: string } | null {
  const lines = splitLines(raw);
  const headers: Array<{ name: string; start: number; end: number }> = [];
  let offset = 0;
  for (const line of lines) {
    const name = parseSectionHeader(line.text);
    if (name != null) {
      headers.push({ name, start: offset, end: offset + line.raw.length });
    }
    offset += line.raw.length;
  }

  const rootHeaders = headers.filter(
    (header) => header.name === GREPMIND_ROOT_SECTION,
  );
  if (rootHeaders.length > 1) {
    throw new Error(
      `${configPath}: duplicate [${GREPMIND_ROOT_SECTION}] sections; clean up manually and retry`,
    );
  }

  const firstRoot = rootHeaders[0];
  const nestedBeforeRoot = headers.find(
    (header) =>
      header.name.startsWith(`${GREPMIND_ROOT_SECTION}.`) &&
      (firstRoot == null || header.start < firstRoot.start),
  );
  if (nestedBeforeRoot != null) {
    throw new Error(
      `${configPath}: [${nestedBeforeRoot.name}] appears before [${GREPMIND_ROOT_SECTION}]; clean up manually and retry`,
    );
  }
  if (firstRoot == null) {
    return null;
  }

  const nextUnrelated = headers.find(
    (header) =>
      header.start > firstRoot.start &&
      header.name !== GREPMIND_ROOT_SECTION &&
      !header.name.startsWith(`${GREPMIND_ROOT_SECTION}.`),
  );
  const end = nextUnrelated?.start ?? raw.length;
  return {
    start: firstRoot.start,
    end,
    block: raw.slice(firstRoot.start, end),
  };
}

function rootSectionLines(block: string): string[] {
  const result: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const header = parseSectionHeader(line);
    if (header != null && header !== GREPMIND_ROOT_SECTION) {
      break;
    }
    if (header == null) {
      result.push(line);
    }
  }
  return result;
}

function parseSectionHeader(line: string): string | null {
  const trimmed = line.trimStart();
  const arrayHeader = /^\[\[([^\]]+)]](?<rest>.*)$/.exec(trimmed);
  const tableHeader = /^\[([^\]]+)](?<rest>.*)$/.exec(trimmed);
  const match = arrayHeader ?? tableHeader;
  if (!match) {
    return null;
  }
  const rest = match.groups?.rest ?? '';
  if (rest.trim() !== '' && !rest.trimStart().startsWith('#')) {
    return null;
  }
  return match[1]!.trim();
}

function parseTomlStringAssignment(
  lines: string[],
  name: string,
): string | undefined {
  for (const line of lines) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(?:#.*)?$`).exec(
      line,
    );
    if (match) {
      return parseTomlString(match[1]!.trim());
    }
  }
  return undefined;
}

function parseTomlStringArrayAssignment(
  lines: string[],
  name: string,
): string[] | undefined {
  for (const line of lines) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(\\[.*])\\s*(?:#.*)?$`).exec(
      line,
    );
    if (match) {
      return parseTomlStringArray(match[1]!);
    }
  }
  return undefined;
}

function parseTomlString(value: string): string | undefined {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return undefined;
}

function parseTomlStringArray(value: string): string[] | undefined {
  const result: string[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '[' || char === ']' || char === ',' || /\s/.test(char ?? '')) {
      index += 1;
      continue;
    }
    if (char !== '"') {
      return undefined;
    }
    let end = index + 1;
    while (end < value.length) {
      if (value[end] === '"' && value[end - 1] !== '\\') {
        break;
      }
      end += 1;
    }
    if (end >= value.length) {
      return undefined;
    }
    const parsed = parseTomlString(value.slice(index, end + 1));
    if (parsed == null) {
      return undefined;
    }
    result.push(parsed);
    index = end + 1;
  }
  return result;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function splitLines(raw: string): Array<{ raw: string; text: string }> {
  const matches = raw.match(/[^\n]*(?:\n|$)/g) ?? [];
  const lines = matches.filter((line) => line.length > 0);
  return lines.map((line) => ({
    raw: line,
    text: line.endsWith('\n') ? line.slice(0, -1) : line,
  }));
}
