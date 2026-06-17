import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextLayerError } from './context-layer-errors.js';

export const CONTEXT_LAYER_SUBAGENT_PROFILE = 'grepmind-context-layer-subagent';

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
  await readRequiredProfile(profilePath);

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
  void codexBin;
  return requireContextLayerSubagentProfile(workspacePath);
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
      `Codex subagent profile was not found at ${profilePath}. Create $CODEX_HOME/grepmind-context-layer-subagent.config.toml.`,
    );
  }
}
