#!/usr/bin/env node
import process from 'node:process';

const PUBLIC_AGENT_COMMANDS = new Set([
  'configure',
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

async function runAgentCommand(args) {
  const agentCommand = args[0];
  if (agentCommand != null && !PUBLIC_AGENT_COMMANDS.has(agentCommand)) {
    throw new Error(`Unknown command: agent ${agentCommand}`);
  }

  const { runAgentCli } = await import('@grepmind/agent');

  await runAgentCli(args);
}

function normalizeAgentArgs(args) {
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'grepmind',
      '',
      'Commands:',
      '  grepmind agent configure --url <backend> [--token <token>]',
      '  grepmind agent register --workspace <path>',
      '  grepmind agent run',
      '  grepmind agent projects',
      '  grepmind agent clean --workspace <path>',
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
