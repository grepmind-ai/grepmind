import process from 'node:process';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_DATA_DIR,
  DEFAULT_HEAD_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from './config.js';

export function printHelp(): void {
  process.stdout.write(
    [
      'grepmind-agent',
      '',
      'Commands:',
      '  auth login --hostname <host> [--name <agent>] [--data-dir <dir>] [--scopes <scope,...>] [--no-open] [--callback-port <port>]',
      '  auth status [--data-dir <dir>]',
      '  auth logout [--data-dir <dir>]',
      '  run [--data-dir <dir>] [-d|--detach] [--trace]',
      '  stop [--data-dir <dir>]',
      '  register --workspace <path> [--display-name <name>] [--branch <branch>] [--data-dir <dir>]',
      '  projects [--data-dir <dir>]',
      '  sync [--binding-id <id>] [--data-dir <dir>]',
      '  status|state [--binding-id <id>] [--branch <branch>] [--commit-sha <sha>] [--limit <n>] [--data-dir <dir>]',
      '  search-head --query <text> [--binding-id <id>] [--workspace <path>] [--target code|docs] [--limit <n>] [--threshold <0-1>] [--no-rerank] [--json] [--data-dir <dir>]',
      '  unbind|remove --binding-id <id> [--data-dir <dir>]',
      '  clean --workspace <path> [--data-dir <dir>]',
      '  clean --all|-a [--data-dir <dir>]',
      '  bootstrap [--data-dir <dir>]',
      '  reset [--data-dir <dir>]',
      '',
      'Authenticate with "grepmind auth login --hostname <host>" or "grepmind-agent auth login --hostname <host>".',
      'Start the long-running agent explicitly with "grepmind agent run".',
      'Use "grepmind agent run -d" to start it in background.',
      'Use "--trace" or GREPMIND_AGENT_TRACE=1 for detailed runtime trace output.',
      'Use GREPMIND_AGENT_TRACE_HTTP=1 to include HTTP trace in the same console stream.',
      'Use "grepmind agent stop" to request graceful shutdown.',
      'All other commands require an already running runtime for the same data dir.',
      '',
      `Defaults: data-dir=${DEFAULT_DATA_DIR}, name=${DEFAULT_AGENT_NAME}, poll=${DEFAULT_POLL_INTERVAL_MS}ms, head-poll=${DEFAULT_HEAD_POLL_INTERVAL_MS}ms`,
      '',
    ].join('\n'),
  );
}
