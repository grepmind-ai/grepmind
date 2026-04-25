#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createAgentConsole } from './cli/cli-context.js';
import { runAgentCli, setAgentCliEntrypointUrl } from './cli/main.js';

setAgentCliEntrypointUrl(import.meta.url);

export { runAgentCli };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runAgentCli(process.argv.slice(2)).catch((error) => {
    createAgentConsole().error('cli', 'Agent CLI failed', error);
    process.exitCode = 1;
  });
}
