#!/usr/bin/env node
import process from 'node:process';

const PUBLIC_AGENT_COMMANDS = new Set([
  'auth',
  'register',
  'run',
  'projects',
  'list',
  'clean',
  'help',
  '--help',
  '-h',
]);

async function main() {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'auth':
      await runAgentCommand(['auth', ...rest]);
      return;
    case 'agent':
      await runAgentCommand(normalizeAgentArgs(rest));
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runAgentCommand(args: string[]) {
  const agentCommand = args[0];
  if (agentCommand != null && !PUBLIC_AGENT_COMMANDS.has(agentCommand)) {
    throw new Error(`Unknown command: agent ${agentCommand}`);
  }

  const { runAgentCli } = await import('@grepmind/agent');

  await runAgentCli(args);
}

function normalizeAgentArgs(args: string[]) {
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'grepmind',
      '',
      'Commands:',
      '  grepmind auth login --hostname <host>',
      '  grepmind auth status',
      '  grepmind auth logout',
      '  grepmind agent auth login --hostname <host>',
      '  grepmind agent register --workspace <path>',
      '  grepmind agent run',
      '  grepmind agent projects',
      '  grepmind agent clean --workspace <path>',
      '  grepmind agent clean --all',
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
