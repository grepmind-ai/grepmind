import {
  authCommand,
  bootstrapCommand,
  cleanProjectCommand,
  listProjectsCommand,
  registerCommand,
  removeProjectCommand,
  resetCommand,
  runCommand,
  searchHeadCommand,
  stateCommand,
  stopCommand,
  syncCommand,
} from './command-handlers/index.js';
import type { AgentCliExecutionContext } from './cli-context.js';
import { printHelp } from './help.js';
import { parseArgs } from './parse-args.js';

let cliEntrypointUrl = import.meta.url;

export function setAgentCliEntrypointUrl(value: string): void {
  cliEntrypointUrl = value;
}

export async function runAgentCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const command = args.command ?? 'help';
  const context: AgentCliExecutionContext = { cliEntrypointUrl };

  switch (command) {
    case 'auth':
      await authCommand(args);
      return;
    case 'run':
      await runCommand(args, context);
      return;
    case 'stop':
      await stopCommand(args);
      return;
    case 'sync':
      await syncCommand(args);
      return;
    case 'status':
    case 'state':
      await stateCommand(args);
      return;
    case 'search-head':
      await searchHeadCommand(args);
      return;
    case 'register':
      await registerCommand(args);
      return;
    case 'projects':
    case 'list':
      await listProjectsCommand(args);
      return;
    case 'unbind':
    case 'remove':
    case 'unregister':
      await removeProjectCommand(args);
      return;
    case 'clean':
      await cleanProjectCommand(args);
      return;
    case 'reset':
      await resetCommand(args);
      return;
    case 'bootstrap':
      await bootstrapCommand(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
