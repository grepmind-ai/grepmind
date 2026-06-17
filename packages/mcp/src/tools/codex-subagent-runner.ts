import { spawn } from 'node:child_process';
import { resolveCodexCliPath, verifyCodexCliShape } from './codex-cli.js';
import {
  formatDiagnosticTail,
  formatProcessDiagnosticTail,
} from './context-layer-diagnostics.js';
import { ContextLayerError } from './context-layer-errors.js';
import {
  toCodexReasoningEffort,
  type ContextLayerThinking,
} from './context-layer-model-config.js';
import {
  CONTEXT_LAYER_SUBAGENT_PROFILE,
  verifyContextLayerSubagentProfile,
} from './context-layer-profile.js';
import {
  normalizeContextPackMarkdown,
  summarizeContextPackForLimit,
} from './context-layer-output.js';

export const DEFAULT_CONTEXT_LAYER_TIMEOUT_MS = 300_000;
export const MAX_CONTEXT_LAYER_TIMEOUT_MS = 600_000;
export const DEFAULT_CONTEXT_LAYER_MAX_OUTPUT_BYTES = 400_000;
export const MIN_CONTEXT_LAYER_MAX_OUTPUT_BYTES = 8_000;
export const DIAGNOSTIC_TAIL_BYTES = 16_000;

export interface CodexSubagentRunInput {
  workspacePath: string;
  prompt: string;
  modelName: string;
  modelThinking: ContextLayerThinking;
  timeoutMs: number;
  maxOutputBytes: number;
  normalizeOutput?: (
    raw: string,
    context: { runtimeDurationMs: number; stderrTail: string },
  ) => string;
  truncateOutput?: (input: {
    output: string;
    maxOutputBytes: number;
    runtimeDurationMs: number;
  }) => string;
}

export interface CodexSubagentRunResult {
  contextPackMarkdown: string;
  contextPackPath?: string;
  runtimeDurationMs: number;
  truncated: boolean;
  timeout: false;
}

export async function runCodexSubagent(
  input: CodexSubagentRunInput,
): Promise<CodexSubagentRunResult> {
  const startedAt = Date.now();
  const codexBin = await resolveCodexCliPath();
  await verifyCodexCliShape(codexBin);
  await verifyContextLayerSubagentProfile(codexBin, input.workspacePath);

  const args = buildCodexExecArgs({
    workspacePath: input.workspacePath,
    modelName: input.modelName,
    modelThinking: input.modelThinking,
  });
  const processResult = await runCodexProcess({
    codexBin,
    args,
    prompt: input.prompt,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    stdoutMaxBytes: Math.max(
      DIAGNOSTIC_TAIL_BYTES,
      input.maxOutputBytes + 64_000,
    ),
  });
  const runtimeDurationMs = Date.now() - startedAt;

  if (processResult.timedOut) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_TIMEOUT',
      `Codex context_layer subagent timed out after ${input.timeoutMs}ms.`,
      { timeout: true, runtimeDurationMs },
    );
  }

  if (processResult.error != null) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `Codex context_layer subagent failed to start: ${processResult.error.message}`,
      { runtimeDurationMs },
    );
  }

  if (processResult.exitCode !== 0) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      formatFailedExitMessage(processResult),
      { runtimeDurationMs },
    );
  }

  const contextPackMarkdown = readLastMessageFromStdout(
    processResult.stdoutTail,
    {
      runtimeDurationMs,
      stderrTail: processResult.stderrTail,
      normalizeOutput: input.normalizeOutput,
    },
  );
  const outputBytes = Buffer.byteLength(contextPackMarkdown, 'utf8');
  if (outputBytes > input.maxOutputBytes) {
    return {
      contextPackMarkdown: (input.truncateOutput ?? truncateContextPack)({
        output: contextPackMarkdown,
        maxOutputBytes: input.maxOutputBytes,
        runtimeDurationMs,
      }),
      runtimeDurationMs,
      truncated: true,
      timeout: false,
    };
  }

  return {
    contextPackMarkdown,
    runtimeDurationMs,
    truncated: false,
    timeout: false,
  };
}

export function resolveContextLayerTimeoutMs(): number {
  const raw = process.env.GREPMIND_CONTEXT_LAYER_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_CONTEXT_LAYER_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_CONTEXT_LAYER_TIMEOUT_MS
  ) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `GREPMIND_CONTEXT_LAYER_TIMEOUT_MS must be a positive integer no greater than ${MAX_CONTEXT_LAYER_TIMEOUT_MS}.`,
    );
  }
  return value;
}

export function resolveContextLayerMaxOutputBytes(): number {
  const raw = process.env.GREPMIND_CONTEXT_LAYER_MAX_OUTPUT_BYTES?.trim();
  if (!raw) {
    return DEFAULT_CONTEXT_LAYER_MAX_OUTPUT_BYTES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_CONTEXT_LAYER_MAX_OUTPUT_BYTES) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `GREPMIND_CONTEXT_LAYER_MAX_OUTPUT_BYTES must be an integer of at least ${MIN_CONTEXT_LAYER_MAX_OUTPUT_BYTES}.`,
    );
  }
  return value;
}

export function buildCodexExecArgs(input: {
  workspacePath: string;
  modelName: string;
  modelThinking: ContextLayerThinking;
}): string[] {
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--profile',
    CONTEXT_LAYER_SUBAGENT_PROFILE,
    '--model',
    input.modelName,
    '--config',
    `model_reasoning_effort=${JSON.stringify(
      toCodexReasoningEffort(input.modelThinking),
    )}`,
    '--config',
    'mcp_servers.node_repl.enabled=false',
    '--config',
    'mcp_servers.playwright.enabled=false',
    '--cd',
    input.workspacePath,
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--color',
    'never',
    '--json',
    '-',
  ];

  return args;
}

function runCodexProcess(input: {
  codexBin: string;
  args: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  stdoutMaxBytes?: number;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  error?: Error;
}> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const stdout = new TailBuffer(
      input.stdoutMaxBytes ?? DIAGNOSTIC_TAIL_BYTES,
    );
    const stderr = new TailBuffer(DIAGNOSTIC_TAIL_BYTES);
    const child = spawn(input.codexBin, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        GREPMIND_CONTEXT_LAYER_SUBAGENT: '1',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2_000).unref();
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.stdin.on('error', () => {
      // The process can exit before stdin is fully written on startup failures.
    });
    child.stdin.end(input.prompt);

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        stdoutTail: stdout.text(),
        stderrTail: stderr.text(),
        error,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdoutTail: stdout.text(),
        stderrTail: stderr.text(),
      });
    });
  });
}

function readLastMessageFromStdout(
  stdoutTail: string,
  context: {
    runtimeDurationMs: number;
    stderrTail: string;
    normalizeOutput?: (
      raw: string,
      context: { runtimeDurationMs: number; stderrTail: string },
    ) => string;
  },
): string {
  const lines = stdoutTail.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith('{')) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: unknown };
      };
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        return (context.normalizeOutput ?? normalizeContextPackMarkdown)(
          event.item.text,
          context,
        );
      }
    } catch {
      // Ignore non-event JSON fragments from Codex diagnostics.
    }
  }
  throw new ContextLayerError(
    'CODEX_SUBAGENT_EMPTY_OUTPUT',
    `Codex context_layer subagent did not return an output message in stdout JSON events. ${formatDiagnosticTail(context.stderrTail)}`,
    { runtimeDurationMs: context.runtimeDurationMs },
  );
}

function truncateContextPack(input: {
  output: string;
  maxOutputBytes: number;
  runtimeDurationMs: number;
}): string {
  return summarizeContextPackForLimit({
    contextPackMarkdown: input.output,
    maxOutputBytes: input.maxOutputBytes,
    runtimeDurationMs: input.runtimeDurationMs,
  });
}

function formatFailedExitMessage(result: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
}): string {
  const exit =
    result.exitCode == null ? `signal ${result.signal}` : result.exitCode;
  return `Codex context_layer subagent exited with ${exit}. ${formatProcessDiagnosticTail(result)}`;
}

class TailBuffer {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > this.maxBytes) {
      this.buffer = this.buffer.subarray(
        this.buffer.byteLength - this.maxBytes,
      );
    }
  }

  text(): string {
    return this.buffer.toString('utf8');
  }
}
