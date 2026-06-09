import path from 'node:path';

import { formatAgentName } from '../agents.js';
import type { GeneratedMcpEntry } from '../mcp-entry.js';
import { resolveWriteDecision } from '../mcp-entry.js';
import {
  parseTomlCommandParts,
  readGrepmindTomlBlock,
  renderCodexGrepmindBlock,
  writeGrepmindTomlBlock,
} from './toml-config.js';
import type { WriteResult } from './json-config.js';

export async function writeCodexConfig(input: {
  workspaceRoot: string;
  generated: GeneratedMcpEntry;
  force: boolean;
  yes: boolean;
  explicit: boolean;
  dryRun: boolean;
  promptReplace: (message: string) => Promise<boolean>;
}): Promise<WriteResult> {
  const configPath = resolveCodexConfigPath(input.workspaceRoot);
  const existing = await readGrepmindTomlBlock(configPath);
  const decision = await resolveWriteDecision({
    agentLabel: formatAgentName('codex'),
    configPath,
    existingEntryPresent: existing.block != null,
    existingCommand: parseTomlCommandParts(existing.block),
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
      agent: 'codex',
      path: configPath,
      status: 'skipped',
      message:
        'existing grepmind entry is unrecognized; rerun without --dry-run to confirm or pass --force',
    };
  }

  const block = renderCodexGrepmindBlock({
    command: decision.command,
    args: decision.args,
    cwd: input.generated.cwd,
    startupTimeoutMs: input.generated.startupTimeoutMs,
    toolTimeoutSec: input.generated.toolTimeoutSec,
    env: input.generated.env,
  });
  const result = await writeGrepmindTomlBlock({
    agent: 'codex',
    workspaceRoot: input.workspaceRoot,
    configPath,
    block,
    dryRun: input.dryRun,
  });
  return {
    ...result,
    message:
      result.status !== 'unchanged' && decision.preservedCommand
        ? 'preserved existing command and args'
        : result.message,
  };
}

export function resolveCodexConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.codex', 'config.toml');
}
