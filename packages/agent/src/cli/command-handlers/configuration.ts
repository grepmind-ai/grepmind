import path from 'node:path';
import process from 'node:process';
import { AgentBackendClient } from '../../backend/agent-backend-client.js';
import {
  ensureDataDir,
  removeAgentCliConfig,
  resolveDataDir,
  toBackendOptions,
} from '../config.js';
import { createAgentConsole } from '../cli-context.js';
import {
  getStringFlag,
} from '../flags.js';
import {
  loadConfigForCommand,
} from '../command-support.js';
import type { ParsedArgs } from '../parse-args.js';

export async function resetCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const dataDir = resolveDataDir(
    getStringFlag(args, 'data-dir') ?? process.env.GREPMIND_AGENT_DATA_DIR,
  );
  await removeAgentCliConfig(dataDir);
  agentConsole.warn(
    'config',
    `Removed ${path.join(dataDir, 'agent-config.json')}`,
  );
}

export async function bootstrapCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const config = await loadConfigForCommand(args);
  const backend = new AgentBackendClient(
    toBackendOptions(config, agentConsole),
  );
  const bootstrap = await backend.bootstrap();
  agentConsole.info(
    'config',
    `Agent API ${bootstrap.agentApiVersion}, server=${bootstrap.serverInstanceId}, poll=${bootstrap.defaultSyncPollIntervalMs}ms`,
  );
}
