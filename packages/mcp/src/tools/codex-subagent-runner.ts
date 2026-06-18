import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexCliPath, verifyCodexCliShape } from './codex-cli.js';
import { formatDiagnosticTail } from './context-layer-diagnostics.js';
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

export interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

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
    outputPath: string;
    runtimeDurationMs: number;
  }) => string;
}

export interface CodexSubagentRunResult {
  contextPackMarkdown: string;
  contextPackPath?: string;
  runtimeDurationMs: number;
  tokenUsage?: CodexTokenUsage;
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

  const runDir = await createRunDir();
  const outputPath = path.join(runDir, 'last-message.md');
  const args = buildCodexExecArgs({
    workspacePath: input.workspacePath,
    outputPath,
    modelName: input.modelName,
    modelThinking: input.modelThinking,
  });
  const processResult = await runCodexProcess({
    codexBin,
    args,
    prompt: input.prompt,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
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

  const contextPackMarkdown = await readLastMessage(outputPath, {
    runtimeDurationMs,
    stderrTail: processResult.stderrTail,
    normalizeOutput: input.normalizeOutput,
  });
  const outputBytes = Buffer.byteLength(contextPackMarkdown, 'utf8');
  if (outputBytes > input.maxOutputBytes) {
    return {
      contextPackMarkdown: (input.truncateOutput ?? truncateContextPack)({
        output: contextPackMarkdown,
        maxOutputBytes: input.maxOutputBytes,
        outputPath,
        runtimeDurationMs,
      }),
      contextPackPath: outputPath,
      runtimeDurationMs,
      tokenUsage: processResult.tokenUsage,
      truncated: true,
      timeout: false,
    };
  }

  void rm(runDir, { recursive: true, force: true });
  return {
    contextPackMarkdown,
    runtimeDurationMs,
    tokenUsage: processResult.tokenUsage,
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
  outputPath: string;
  modelName: string;
  modelThinking: ContextLayerThinking;
}): string[] {
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
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
    '--output-last-message',
    input.outputPath,
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
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  tokenUsage?: CodexTokenUsage;
  error?: Error;
}> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutRemainder = '';
    let tokenUsage: CodexTokenUsage | undefined;
    const stdout = new TailBuffer(DIAGNOSTIC_TAIL_BYTES);
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
    child.stdout.setEncoding('utf8');

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2_000).unref();
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: string) => {
      stdout.append(Buffer.from(chunk));
      stdoutRemainder = processJsonlStdout(chunk, stdoutRemainder, (usage) => {
        tokenUsage = usage;
      });
    });
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
        tokenUsage,
        error,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (stdoutRemainder.trim()) {
        processJsonlLine(stdoutRemainder, (usage) => {
          tokenUsage = usage;
        });
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        stdoutTail: stdout.text(),
        stderrTail: stderr.text(),
        tokenUsage,
      });
    });
  });
}

function processJsonlStdout(
  chunk: string,
  previousRemainder: string,
  onUsage: (usage: CodexTokenUsage) => void,
): string {
  let buffer = `${previousRemainder}${chunk}`;

  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      return buffer;
    }

    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    processJsonlLine(line, onUsage);
  }
}

function processJsonlLine(
  line: string,
  onUsage: (usage: CodexTokenUsage) => void,
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    const event = JSON.parse(trimmed) as {
      type?: unknown;
      usage?: unknown;
    };
    if (event.type === 'turn.completed' && isTokenUsage(event.usage)) {
      onUsage(event.usage);
    }
  } catch {
    // Keep stdout parsing best-effort; the final answer is read from
    // --output-last-message and stderr still carries diagnostics.
  }
}

function isTokenUsage(value: unknown): value is CodexTokenUsage {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const usage = value as Record<string, unknown>;
  return (
    isOptionalNumber(usage.input_tokens) &&
    isOptionalNumber(usage.cached_input_tokens) &&
    isOptionalNumber(usage.output_tokens) &&
    isOptionalNumber(usage.reasoning_output_tokens)
  );
}

function isOptionalNumber(value: unknown): boolean {
  return value == null || typeof value === 'number';
}

async function readLastMessage(
  outputPath: string,
  context: {
    runtimeDurationMs: number;
    stderrTail: string;
    normalizeOutput?: (
      raw: string,
      context: { runtimeDurationMs: number; stderrTail: string },
    ) => string;
  },
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(outputPath, 'utf8');
  } catch {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_EMPTY_OUTPUT',
      `Codex context_layer subagent did not write an output message. ${formatDiagnosticTail(context.stderrTail)}`,
      { runtimeDurationMs: context.runtimeDurationMs },
    );
  }

  return (context.normalizeOutput ?? normalizeContextPackMarkdown)(
    raw,
    context,
  );
}

function truncateContextPack(input: {
  output: string;
  maxOutputBytes: number;
  outputPath: string;
  runtimeDurationMs: number;
}): string {
  return summarizeContextPackForLimit({
    contextPackMarkdown: input.output,
    maxOutputBytes: input.maxOutputBytes,
    fullContextPackPath: input.outputPath,
    runtimeDurationMs: input.runtimeDurationMs,
  });
}

function formatFailedExitMessage(result: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}): string {
  const exit =
    result.exitCode == null ? `signal ${result.signal}` : result.exitCode;
  return `Codex context_layer subagent exited with ${exit}. ${formatDiagnosticTail(result.stderrTail)}`;
}

async function createRunDir(): Promise<string> {
  const root = path.join(os.tmpdir(), 'grepmind-context-layer');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'run-'));
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
