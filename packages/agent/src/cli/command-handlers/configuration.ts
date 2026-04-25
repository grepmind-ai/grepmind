import path from 'node:path';
import process from 'node:process';
import { AgentBackendClient } from '../../backend/agent-backend-client.js';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_HEAD_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  ensureDataDir,
  removeAgentCliConfig,
  resolveDataDir,
  saveAgentCliConfig,
  toBackendOptions,
  type AgentCliConfig,
} from '../config.js';
import { createAgentConsole } from '../cli-context.js';
import {
  getIntegerFlag,
  getStringFlag,
  nonEmptyString,
  requireStringFlag,
  toInteger,
} from '../flags.js';
import {
  loadConfigForCommand,
  loadOptionalConfig,
} from '../command-support.js';
import type { ParsedArgs } from '../parse-args.js';

export async function configureCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const dataDir = resolveDataDir(
    getStringFlag(args, 'data-dir') ?? process.env.GREPMIND_AGENT_DATA_DIR,
  );
  await ensureDataDir(dataDir);
  const existingConfig = await loadOptionalConfig(dataDir);
  const config: AgentCliConfig = {
    apiBaseUrl: requireStringFlag(args, 'url', process.env.GREPMIND_AGENT_URL),
    accessToken:
      getStringFlag(args, 'token') ?? process.env.GREPMIND_AGENT_TOKEN,
    apiKey:
      getStringFlag(args, 'api-key') ?? process.env.GREPMIND_AGENT_API_KEY,
    name:
      getStringFlag(args, 'name') ??
      process.env.GREPMIND_AGENT_NAME ??
      DEFAULT_AGENT_NAME,
    pollIntervalMs:
      getIntegerFlag(args, 'poll-interval-ms') ??
      toInteger(process.env.GREPMIND_AGENT_POLL_INTERVAL_MS) ??
      existingConfig?.pollIntervalMs ??
      DEFAULT_POLL_INTERVAL_MS,
    headPollIntervalMs:
      getIntegerFlag(args, 'head-poll-interval-ms') ??
      toInteger(process.env.GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS) ??
      existingConfig?.headPollIntervalMs ??
      DEFAULT_HEAD_POLL_INTERVAL_MS,
    deviceId:
      nonEmptyString(
        getStringFlag(args, 'device-id') ??
          process.env.GREPMIND_AGENT_DEVICE_ID,
      ) ??
      existingConfig?.deviceId ??
      '',
    dataDir,
  };

  const backend = new AgentBackendClient(
    toBackendOptions(config, agentConsole),
  );
  const bootstrap = await backend.bootstrap();
  const configPath = await saveAgentCliConfig(config);

  agentConsole.success(
    'config',
    `Configured agent "${config.name}" at ${configPath}`,
  );
  agentConsole.info(
    'config',
    `Connected to ${config.apiBaseUrl} (api=${bootstrap.agentApiVersion}, server=${bootstrap.serverInstanceId})`,
  );
}

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
