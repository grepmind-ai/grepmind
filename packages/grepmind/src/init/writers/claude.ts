import path from 'node:path';

import { formatAgentName } from '../agents.js';
import type { GeneratedMcpEntry } from '../mcp-entry.js';
import { writeJsonMcpEntry, type WriteResult } from './json-config.js';

export async function writeClaudeConfig(input: {
  workspaceRoot: string;
  generated: GeneratedMcpEntry;
  force: boolean;
  yes: boolean;
  explicit: boolean;
  dryRun: boolean;
  promptReplace: (message: string) => Promise<boolean>;
}): Promise<WriteResult> {
  return writeJsonMcpEntry({
    agent: 'claude',
    agentLabel: formatAgentName('claude'),
    workspaceRoot: input.workspaceRoot,
    configPath: resolveClaudeConfigPath(input.workspaceRoot),
    generated: input.generated,
    force: input.force,
    yes: input.yes,
    explicit: input.explicit,
    dryRun: input.dryRun,
    promptReplace: input.promptReplace,
  });
}

export function resolveClaudeConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mcp.json');
}
