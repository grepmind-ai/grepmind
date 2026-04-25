import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { AgentRuntimeServer } from '../../runtime/server/agent-runtime-server.js';
import {
  AgentRuntimeClient,
  isRuntimeUnavailableError,
  spawnAgentRuntimeProcess,
  waitForAgentRuntimeReady,
} from '../../runtime/client.js';
import type { AgentCliExecutionContext } from '../cli-context.js';
import { createAgentConsole } from '../cli-context.js';
import { hasBooleanFlag } from '../flags.js';
import { loadConfigForCommand } from '../command-support.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runCommand(
  args: ParsedArgs,
  context: AgentCliExecutionContext,
): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const config = await loadConfigForCommand(args);

  if (hasBooleanFlag(args, 'd') || hasBooleanFlag(args, 'detach')) {
    await spawnAgentRuntimeProcess(context.cliEntrypointUrl, config.dataDir, {
      traceEnabled: agentConsole.traceEnabled,
    });
    await waitForAgentRuntimeReady(config.dataDir);
    agentConsole.success(
      'runtime',
      `Agent runtime started in background for ${config.dataDir}`,
    );
    return;
  }

  agentConsole.renderStartupSplash({
    name: config.name,
    apiBaseUrl: config.apiBaseUrl,
    dataDir: config.dataDir,
    pollIntervalMs: config.pollIntervalMs,
    headPollIntervalMs: config.headPollIntervalMs,
    traceEnabled: agentConsole.traceEnabled,
  });
  agentConsole.beginStartup('Booting Grepmind agent runtime');

  const runtimeServer = new AgentRuntimeServer(config, {
    logger: agentConsole,
  });

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    agentConsole.warn('runtime', `Received ${signal}; shutting down`);
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    await runtimeServer.stop();
  };
  const onSigInt = () => {
    void stop('SIGINT');
  };
  const onSigTerm = () => {
    void stop('SIGTERM');
  };

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    await runtimeServer.start();
    agentConsole.completeStartup(`Grepmind agent "${config.name}" is online`);
    await runtimeServer.waitForStop();
    agentConsole.info('runtime', 'Agent runtime stopped');
  } catch (error) {
    agentConsole.failStartup('Failed to boot Grepmind agent runtime', error);
    throw error;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    await runtimeServer.stop();
  }
}

export async function stopCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const config = await loadConfigForCommand(args);
  const client = new AgentRuntimeClient(config.dataDir);

  try {
    await client.shutdown({
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    if (isRuntimeUnavailableError(error)) {
      throw new Error(`Agent runtime is not running for ${config.dataDir}`);
    }
    throw error;
  }

  agentConsole.info(
    'runtime',
    `Agent runtime stop requested for ${config.dataDir}`,
  );
}
