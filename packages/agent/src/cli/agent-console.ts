import process from 'node:process';
import pc from 'picocolors';
import type { AgentLogger, AgentLogScope } from '../logging/agent-logger.js';

interface AgentConsoleOptions {
  traceEnabled?: boolean;
}

interface StartupSummary {
  name: string;
  apiBaseUrl: string;
  dataDir: string;
  pollIntervalMs: number;
  headPollIntervalMs: number;
  traceEnabled: boolean;
}

const SPLASH_ART_LINES = [
  '   _____ _____  ______ _____  __  __ _____ _   _ _____  ',
  '  / ____|  __ \\|  ____|  __ \\|  \\/  |_   _| \\ | |  __ \\ ',
  ' | |  __| |__) | |__  | |__) | \\  / | | | |  \\| | |  | |',
  ' | | |_ |  _  /|  __| |  ___/| |\\/| | | | | . ` | |  | |',
  ' | |__| | | \\ \\| |____| |    | |  | |_| |_| |\\  | |__| |',
  '  \\_____|_|  \\_\\______|_|    |_|  |_|_____|_| \\_|_____/ ',
] as const;

const SPLASH_PANEL_WIDTH = 74;

const SCOPE_STYLES: Record<AgentLogScope, (label: string) => string> = {
  cli: (label) => pc.black(pc.bgBlue(label)),
  config: (label) => pc.black(pc.bgCyan(label)),
  runtime: (label) => pc.black(pc.bgGreen(label)),
  sync: (label) => pc.white(pc.bgMagenta(label)),
  publish: (label) => pc.black(pc.bgYellow(label)),
  attach: (label) => pc.black(pc.bgRed(label)),
  project: (label) => pc.black(pc.bgCyan(label)),
  http: (label) => pc.white(pc.bgBlack(label)),
};

export class AgentConsole implements AgentLogger {
  readonly traceEnabled: boolean;

  constructor(options: AgentConsoleOptions = {}) {
    this.traceEnabled = options.traceEnabled ?? false;
  }

  renderStartupSplash(summary: StartupSummary): void {
    if (!process.stdout.isTTY) {
      this.info(
        'runtime',
        `Starting ${summary.name} (${summary.apiBaseUrl}) trace=${summary.traceEnabled ? 'on' : 'off'}`,
      );
      return;
    }

    const panelBorder = pc.dim(`+${'-'.repeat(SPLASH_PANEL_WIDTH + 2)}+`);
    const artColors = [
      pc.cyan,
      pc.cyan,
      pc.blue,
      pc.blue,
      pc.magenta,
      pc.magenta,
    ] as const;

    process.stdout.write('\n');
    SPLASH_ART_LINES.forEach((line, index) => {
      process.stdout.write(`${artColors[index](line)}\n`);
    });
    process.stdout.write('\n');
    process.stdout.write(`${panelBorder}\n`);
    writeSplashPanelLine(formatSplashSummary('Agent', summary.name), (value) =>
      pc.white(value),
    );
    writeSplashPanelLine(
      formatSplashSummary('Backend', summary.apiBaseUrl),
      (value) => pc.white(value),
    );
    writeSplashPanelLine(
      formatSplashSummary('Data dir', summary.dataDir),
      (value) => pc.white(value),
    );
    writeSplashPanelLine(
      formatSplashSummary(
        'Trace',
        summary.traceEnabled ? 'enabled' : 'disabled',
      ),
      summary.traceEnabled
        ? (value) => pc.yellow(value)
        : (value) => pc.green(value),
    );
    process.stdout.write(`${panelBorder}\n\n`);
  }

  beginStartup(message: string): void {
    this.info('runtime', message);
  }

  completeStartup(message: string): void {
    this.success('runtime', message);
  }

  failStartup(message: string, error?: unknown): void {
    this.error('runtime', message, error);
  }

  info(scope: AgentLogScope, message: string): void {
    this.write(scope, 'info', message);
  }

  success(scope: AgentLogScope, message: string): void {
    this.write(scope, 'success', message);
  }

  warn(scope: AgentLogScope, message: string): void {
    this.write(scope, 'warn', message);
  }

  error(scope: AgentLogScope, message: string, error?: unknown): void {
    this.write(scope, 'error', composeErrorMessage(message, error), {
      stream: process.stderr,
    });
    if (this.traceEnabled && error instanceof Error && error.stack) {
      const stackLines = error.stack.split('\n').slice(1);
      for (const line of stackLines) {
        this.write(scope, 'trace', line.trim(), { stream: process.stderr });
      }
    }
  }

  trace(scope: AgentLogScope, message: string): void {
    if (!this.traceEnabled) {
      return;
    }

    this.write(scope, 'trace', message);
  }

  private write(
    scope: AgentLogScope,
    kind: 'info' | 'success' | 'warn' | 'error' | 'trace',
    message: string,
    options: { stream?: NodeJS.WriteStream } = {},
  ): void {
    const stream = options.stream ?? process.stdout;
    const timestamp = pc.dim(formatTimestamp(new Date()));
    const label = formatScopeLabel(scope);
    const symbol = formatSymbol(kind);
    const rendered = kind === 'trace' ? pc.dim(message) : message;
    stream.write(`${timestamp} ${symbol} ${label} ${rendered}\n`);
  }
}

function formatScopeLabel(scope: AgentLogScope): string {
  const style = SCOPE_STYLES[scope];
  return style(` ${scope.toUpperCase().padEnd(7, ' ')} `);
}

function formatSymbol(
  kind: 'info' | 'success' | 'warn' | 'error' | 'trace',
): string {
  switch (kind) {
    case 'info':
      return pc.cyan('i');
    case 'success':
      return pc.green('+');
    case 'warn':
      return pc.yellow('!');
    case 'error':
      return pc.red('x');
    case 'trace':
      return pc.dim('.');
    default:
      return '';
  }
}

function composeErrorMessage(message: string, error?: unknown): string {
  const suffix = formatError(error);
  return suffix ? `${message}: ${suffix}` : message;
}

function formatError(error: unknown): string {
  if (!error) {
    return '';
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatTimestamp(value: Date): string {
  return value.toISOString().slice(11, 19);
}

function writeSplashPanelLine(
  value: string,
  render: (value: string) => string = (line) => line,
): void {
  process.stdout.write(
    `${pc.dim('|')} ${render(fitText(value, SPLASH_PANEL_WIDTH))} ${pc.dim('|')}\n`,
  );
}

function formatSplashSummary(label: string, value: string): string {
  const prefix = `${label.toUpperCase().padEnd(9, ' ')} `;
  const availableWidth = Math.max(0, SPLASH_PANEL_WIDTH - prefix.length);
  return `${prefix}${truncateText(value, availableWidth)}`;
}

function fitText(value: string, width: number): string {
  if (value.length >= width) {
    return truncateText(value, width);
  }
  return value.padEnd(width, ' ');
}

function truncateText(value: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return '.'.repeat(width);
  }
  return `${value.slice(0, width - 3)}...`;
}
