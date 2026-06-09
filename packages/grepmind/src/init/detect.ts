import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { DetectedAgentName, InitAgentName } from './agents.js';

export interface DetectionResult {
  detectedSupported: InitAgentName[];
  detectedUnsupported: Exclude<DetectedAgentName, InitAgentName>[];
}

export async function detectInitAgents(
  workspaceRoot: string,
): Promise<DetectionResult> {
  const [codex, claude, cursor, opencode, gemini] = await Promise.all([
    existsAny(workspaceRoot, ['.codex', '.codex/config.toml']),
    existsAny(workspaceRoot, ['.mcp.json', '.claude']),
    existsAny(workspaceRoot, ['.cursor', '.cursor/mcp.json']),
    existsAny(workspaceRoot, [
      'opencode.json',
      'opencode.jsonc',
      '.opencode.json',
      '.opencode.jsonc',
    ]),
    existsAny(workspaceRoot, ['.gemini', '.gemini/settings.json']),
  ]);

  return {
    detectedSupported: [
      ...(codex ? (['codex'] as const) : []),
      ...(claude ? (['claude'] as const) : []),
      ...(cursor ? (['cursor'] as const) : []),
    ],
    detectedUnsupported: [
      ...(opencode ? (['opencode'] as const) : []),
      ...(gemini ? (['gemini'] as const) : []),
    ],
  };
}

async function existsAny(
  workspaceRoot: string,
  relativePaths: string[],
): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await exists(path.join(workspaceRoot, relativePath))) {
      return true;
    }
  }
  return false;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
