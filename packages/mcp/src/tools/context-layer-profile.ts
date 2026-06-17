import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ContextLayerError } from './context-layer-errors.js';

export const CONTEXT_LAYER_SUBAGENT_PROFILE = 'grepmind-context-layer-subagent';
const CODEX_MCP_LIST_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export interface ContextLayerSubagentProfile {
  codexHome: string;
  profilePath: string;
  workspaceConfigPath: string;
}

export async function requireContextLayerSubagentProfile(
  workspacePath: string,
): Promise<ContextLayerSubagentProfile> {
  const codexHome = resolveCodexHome();
  const profilePath = path.join(
    codexHome,
    `${CONTEXT_LAYER_SUBAGENT_PROFILE}.config.toml`,
  );
  const workspaceConfigPath = path.join(workspacePath, '.codex', 'config.toml');
  const profileRaw = await readRequiredProfile(profilePath);
  const workspaceConfigRaw = await readOptionalText(workspaceConfigPath);

  if (!hasGrepmindMcp(profileRaw) && !hasGrepmindMcp(workspaceConfigRaw)) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_PROFILE_MISSING',
      `Codex subagent profile is present at ${profilePath}, but Grepmind MCP was not found in the profile or ${workspaceConfigPath}. Configure the grepmind-context-layer-subagent profile or project .codex/config.toml so the subagent can call code_search.`,
    );
  }

  return {
    codexHome,
    profilePath,
    workspaceConfigPath,
  };
}

export async function verifyContextLayerSubagentProfile(
  codexBin: string,
  workspacePath: string,
): Promise<ContextLayerSubagentProfile> {
  const profile = await requireContextLayerSubagentProfile(workspacePath);
  const mcpList = await readCodexMcpList(codexBin, workspacePath);
  if (!mcpList.ok) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_PROFILE_MISSING',
      `Codex subagent profile ${CONTEXT_LAYER_SUBAGENT_PROFILE} could not be checked with "codex mcp list --json". Configure the profile and project .codex/config.toml so the subagent can call code_search. ${mcpList.message}`,
    );
  }

  if (!hasEnabledGrepmindServer(mcpList.output)) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_PROFILE_MISSING',
      `Codex subagent profile ${CONTEXT_LAYER_SUBAGENT_PROFILE} does not expose an enabled Grepmind MCP server in ${workspacePath}. Configure the profile or project .codex/config.toml so the subagent can call code_search.`,
    );
  }

  return profile;
}

export function resolveCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.codex');
}

async function readRequiredProfile(profilePath: string): Promise<string> {
  try {
    await access(profilePath);
    return await readFile(profilePath, 'utf8');
  } catch {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_PROFILE_MISSING',
      `Codex subagent profile was not found at ${profilePath}. Create $CODEX_HOME/grepmind-context-layer-subagent.config.toml and keep Grepmind code_search available through that profile or the project .codex/config.toml.`,
    );
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function hasGrepmindMcp(raw: string | null): boolean {
  if (raw == null) {
    return false;
  }
  return (
    /^\s*\[mcp_servers\.grepmind\]\s*$/m.test(raw) ||
    /^\s*\[mcpServers\.grepmind\]\s*$/m.test(raw) ||
    /grepmind-mcp|@grepmind\/mcp/.test(raw)
  );
}

async function readCodexMcpList(
  codexBin: string,
  workspacePath: string,
): Promise<{ ok: boolean; output: string; message: string }> {
  try {
    const result = await execFileAsync(
      codexBin,
      [
        '--profile',
        CONTEXT_LAYER_SUBAGENT_PROFILE,
        '--cd',
        workspacePath,
        'mcp',
        'list',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: CODEX_MCP_LIST_TIMEOUT_MS,
        env: {
          ...process.env,
          GREPMIND_CONTEXT_LAYER_SUBAGENT: '1',
          NO_COLOR: '1',
        },
      },
    );
    return { ok: true, output: result.stdout ?? '', message: '' };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const message = stripAnsi(
      `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() ||
        err.message ||
        String(error),
    ).trim();
    return { ok: false, output: '', message };
  }
}

function hasEnabledGrepmindServer(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }

  return parsed.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return entry.name === 'grepmind' && entry.enabled === true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, '');
}
