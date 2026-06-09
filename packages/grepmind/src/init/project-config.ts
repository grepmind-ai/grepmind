import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertAllowedProjectWrite, isNotFound, writeTextFileAtomic } from './file.js';
import { normalizeHostname } from './hostname.js';

export const GREPMIND_PROJECT_CONFIG_FILENAME = '.grepmind.json';
export const GREPMIND_PROJECT_SCHEMA =
  'https://grepmind.dev/schemas/grepmind-project-config.v1.json';

export interface ProjectConfigReadResult {
  path: string;
  exists: boolean;
  config: Record<string, unknown> | null;
  raw: string | null;
  hostname?: string;
}

export interface ProjectConfigWriteInput {
  workspaceRoot: string;
  existing: ProjectConfigReadResult;
  hostname: string;
  mcpPackage: string;
  startupTimeoutMs: number;
  dryRun: boolean;
}

export interface ConfigWriteResult {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'would-change';
}

export async function readProjectConfig(
  workspaceRoot: string,
): Promise<ProjectConfigReadResult> {
  const configPath = path.join(workspaceRoot, GREPMIND_PROJECT_CONFIG_FILENAME);
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = parseJsonObject(raw, configPath);
    const hostname =
      typeof parsed.hostname === 'string'
        ? normalizeHostname(parsed.hostname, `${configPath} hostname`)
        : undefined;
    return {
      path: configPath,
      exists: true,
      config: parsed,
      raw,
      hostname,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        path: configPath,
        exists: false,
        config: null,
        raw: null,
      };
    }
    throw error;
  }
}

export async function writeProjectConfig(
  input: ProjectConfigWriteInput,
): Promise<ConfigWriteResult> {
  const nextConfig = buildProjectConfig(input);
  const nextRaw = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const changed = input.existing.raw !== nextRaw;
  if (!changed) {
    return { path: input.existing.path, status: 'unchanged' };
  }
  if (input.dryRun) {
    return {
      path: input.existing.path,
      status: 'would-change',
    };
  }

  assertAllowedProjectWrite(input.workspaceRoot, input.existing.path);
  await writeTextFileAtomic({
    root: input.workspaceRoot,
    targetPath: input.existing.path,
    content: nextRaw,
  });

  return {
    path: input.existing.path,
    status: input.existing.exists ? 'updated' : 'created',
  };
}

export function buildProjectConfig(input: {
  existing: ProjectConfigReadResult;
  hostname: string;
  mcpPackage: string;
  startupTimeoutMs: number;
}): Record<string, unknown> {
  const existingConfig = input.existing.config ?? {};
  const unknownTopLevel = { ...existingConfig };
  delete unknownTopLevel.$schema;
  delete unknownTopLevel.version;
  delete unknownTopLevel.hostname;
  delete unknownTopLevel.mcp;

  const existingMcp = isRecord(existingConfig.mcp) ? existingConfig.mcp : {};
  const unknownMcp = { ...existingMcp };
  delete unknownMcp.serverName;
  delete unknownMcp.package;
  delete unknownMcp.startupTimeoutMs;

  return {
    $schema: GREPMIND_PROJECT_SCHEMA,
    version: 1,
    hostname: input.hostname,
    mcp: {
      serverName: 'grepmind',
      package: input.mcpPackage,
      startupTimeoutMs: input.startupTimeoutMs,
      ...unknownMcp,
    },
    ...unknownTopLevel,
  };
}

function parseJsonObject(raw: string, configPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('top-level value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}
