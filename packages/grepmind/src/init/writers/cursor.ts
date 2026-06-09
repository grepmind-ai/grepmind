import path from 'node:path';

import { formatAgentName } from '../agents.js';
import type { GeneratedMcpEntry } from '../mcp-entry.js';
import { writeJsonMcpEntry, type WriteResult } from './json-config.js';

export async function writeCursorConfig(input: {
  workspaceRoot: string;
  generated: GeneratedMcpEntry;
  force: boolean;
  yes: boolean;
  explicit: boolean;
  dryRun: boolean;
  promptReplace: (message: string) => Promise<boolean>;
}): Promise<WriteResult> {
  return writeJsonMcpEntry({
    agent: 'cursor',
    agentLabel: formatAgentName('cursor'),
    workspaceRoot: input.workspaceRoot,
    configPath: resolveCursorConfigPath(input.workspaceRoot),
    generated: input.generated,
    force: input.force,
    yes: input.yes,
    explicit: input.explicit,
    dryRun: input.dryRun,
    includeType: true,
    promptReplace: input.promptReplace,
  });
}

export function resolveCursorConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.cursor', 'mcp.json');
}
