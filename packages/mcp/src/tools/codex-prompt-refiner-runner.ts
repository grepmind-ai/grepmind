import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexCliPath, verifyCodexCliShape } from './codex-cli.js';
import {
  getPromptRefinerDisableFeatureArgs,
  getPromptRefinerMcpConfigArgs,
} from './codex-feature-flags.js';
import { formatDiagnosticTail } from './context-layer-diagnostics.js';
import { ContextLayerError } from './context-layer-errors.js';
import {
  toCodexReasoningEffort,
  type ContextLayerThinking,
} from './context-layer-model-config.js';
import { buildContextLayerPromptRefinerPrompt } from './context-layer-prompt-refiner.js';
import type { ContextLayerPromptRefinerInput } from './context-layer-prompt-refiner.js';
import { parsePromptRefinerOutput } from './prompt-refiner-output.js';
import type { PromptRefinerOutput } from './prompt-refiner-output.js';

export const DEFAULT_PROMPT_REFINER_TIMEOUT_MS = 45_000;
export const MAX_PROMPT_REFINER_TIMEOUT_MS = 120_000;

interface PromptRefinerRunInput extends ContextLayerPromptRefinerInput {
  modelName: string;
  modelThinking: ContextLayerThinking;
  timeoutMs: number;
}

export interface PromptRefinerRunResult {
  output: PromptRefinerOutput;
  runtimeDurationMs: number;
  timeout: false;
}

export async function runPromptRefinerSubagent(
  input: PromptRefinerRunInput,
): Promise<PromptRefinerRunResult> {
  const startedAt = Date.now();
  const codexBin = await resolveCodexCliPath();
  await verifyCodexCliShape(codexBin);

  const runDir = await createRunDir();
  const outputPath = path.join(runDir, 'last-message.json');
  const args = buildPromptRefinerExecArgs({
    workspacePath: input.workspacePath,
    outputPath,
    modelName: input.modelName,
    modelThinking: input.modelThinking,
  });
  const processResult = await runCodexProcess({
    codexBin,
    args,
    prompt: buildContextLayerPromptRefinerPrompt(input),
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  const runtimeDurationMs = Date.now() - startedAt;

  if (processResult.timedOut) {
    throw new ContextLayerError(
      'PROMPT_REFINER_TIMEOUT',
      `Codex prompt-refiner timed out after ${input.timeoutMs}ms.`,
      { timeout: true, runtimeDurationMs },
    );
  }

  if (processResult.error != null) {
    throw new ContextLayerError(
      'PROMPT_REFINER_FAILED',
      `Codex prompt-refiner failed to start: ${processResult.error.message}`,
      { runtimeDurationMs },
    );
  }

  if (processResult.exitCode !== 0) {
    throw new ContextLayerError(
      'PROMPT_REFINER_FAILED',
      formatFailedExitMessage(processResult),
      { runtimeDurationMs },
    );
  }

  const rawOutput = await readLastMessage(outputPath, {
    runtimeDurationMs,
    stderrTail: processResult.stderrTail,
  });
  let output: PromptRefinerOutput;
  try {
    output = parsePromptRefinerOutput(rawOutput);
  } catch (error) {
    if (error instanceof ContextLayerError) {
      throw new ContextLayerError(error.code, error.message, {
        timeout: error.timeout,
        runtimeDurationMs,
      });
    }
    throw error;
  }

  void rm(runDir, { recursive: true, force: true });
  return {
    output,
    runtimeDurationMs,
    timeout: false,
  };
}

export function resolvePromptRefinerTimeoutMs(): number {
  const raw =
    process.env.GREPMIND_CONTEXT_LAYER_PROMPT_REFINER_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_PROMPT_REFINER_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_PROMPT_REFINER_TIMEOUT_MS
  ) {
    throw new ContextLayerError(
      'PROMPT_REFINER_FAILED',
      `GREPMIND_CONTEXT_LAYER_PROMPT_REFINER_TIMEOUT_MS must be a positive integer no greater than ${MAX_PROMPT_REFINER_TIMEOUT_MS}.`,
    );
  }
  return value;
}

function buildPromptRefinerExecArgs(input: {
  workspacePath: string;
  outputPath: string;
  modelName: string;
  modelThinking: ContextLayerThinking;
}): string[] {
  return [
    '--ask-for-approval',
    'never',
    ...getPromptRefinerDisableFeatureArgs(),
    'exec',
    '--ignore-rules',
    '--model',
    input.modelName,
    '--config',
    `model_reasoning_effort=${JSON.stringify(
      toCodexReasoningEffort(input.modelThinking),
    )}`,
    ...getPromptRefinerMcpConfigArgs(),
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
  error?: Error;
}> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const stdout = new TailBuffer(16_000);
    const stderr = new TailBuffer(16_000);
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

async function readLastMessage(
  outputPath: string,
  context: { runtimeDurationMs: number; stderrTail: string },
): Promise<string> {
  try {
    return await readFile(outputPath, 'utf8');
  } catch {
    throw new ContextLayerError(
      'PROMPT_REFINER_EMPTY_OUTPUT',
      `Codex prompt-refiner did not write an output message. ${formatDiagnosticTail(context.stderrTail)}`,
      { runtimeDurationMs: context.runtimeDurationMs },
    );
  }
}

function formatFailedExitMessage(result: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}): string {
  const exit =
    result.exitCode == null ? `signal ${result.signal}` : result.exitCode;
  return `Codex prompt-refiner exited with ${exit}. ${formatDiagnosticTail(result.stderrTail)}`;
}

async function createRunDir(): Promise<string> {
  const root = path.join(os.tmpdir(), 'grepmind-context-layer-prompt-refiner');
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
