import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ContextLayerError } from './context-layer-errors.js';

const execFileAsync = promisify(execFile);
const CODEX_CLI_SHAPE_TIMEOUT_MS = 15_000;
const MACOS_CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';

export async function resolveCodexCliPath(): Promise<string> {
  const configured = process.env.GREPMIND_CONTEXT_LAYER_CODEX_BIN?.trim();
  if (configured) {
    if (await isExecutable(configured)) {
      return configured;
    }
    throw new ContextLayerError(
      'CODEX_CLI_NOT_FOUND',
      `Codex CLI was not found at GREPMIND_CONTEXT_LAYER_CODEX_BIN=${configured}. Install Codex CLI or set GREPMIND_CONTEXT_LAYER_CODEX_BIN to an executable codex binary.`,
    );
  }

  const fromPath = await findExecutableInPath('codex');
  if (fromPath) {
    return fromPath;
  }

  if (
    process.platform === 'darwin' &&
    (await isExecutable(MACOS_CODEX_APP_BIN))
  ) {
    return MACOS_CODEX_APP_BIN;
  }

  throw new ContextLayerError(
    'CODEX_CLI_NOT_FOUND',
    'Codex CLI was not found. Install Codex CLI or set GREPMIND_CONTEXT_LAYER_CODEX_BIN.',
  );
}

export async function verifyCodexCliShape(codexBin: string): Promise<void> {
  const version = await runCodexHelpCommand(codexBin, ['--version']);
  if (!version.ok) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `Codex CLI at ${codexBin} did not respond to --version. ${version.message}`,
    );
  }

  const rootHelp = await runCodexHelpCommand(codexBin, ['--help']);
  if (!rootHelp.ok || !rootHelp.output.includes('--ask-for-approval')) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `Codex CLI at ${codexBin} does not expose the global --ask-for-approval flag. Upgrade Codex CLI or set GREPMIND_CONTEXT_LAYER_CODEX_BIN to a compatible binary.`,
    );
  }

  const execHelp = await runCodexHelpCommand(codexBin, ['exec', '--help']);
  const missingExecFlags = [
    '--sandbox',
    '--cd',
    '--ephemeral',
    '--color',
    '--output-last-message',
    '--profile',
  ].filter((flag) => !execHelp.output.includes(flag));
  if (!execHelp.ok || missingExecFlags.length > 0) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `Codex CLI at ${codexBin} is missing required exec flags: ${missingExecFlags.join(', ')}. Upgrade Codex CLI or set GREPMIND_CONTEXT_LAYER_CODEX_BIN to a compatible binary.`,
    );
  }

  const globalApprovalHelp = await runCodexHelpCommand(codexBin, [
    '--ask-for-approval',
    'never',
    'exec',
    '--help',
  ]);
  if (!globalApprovalHelp.ok) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `Codex CLI at ${codexBin} does not accept --ask-for-approval before exec. Upgrade Codex CLI or set GREPMIND_CONTEXT_LAYER_CODEX_BIN to a compatible binary. ${globalApprovalHelp.message}`,
    );
  }

  await runCodexHelpCommand(codexBin, [
    'exec',
    '--ask-for-approval',
    'never',
    '--help',
  ]);
}

async function runCodexHelpCommand(
  codexBin: string,
  args: string[],
): Promise<{ ok: boolean; output: string; message: string }> {
  try {
    const result = await execFileAsync(codexBin, args, {
      encoding: 'utf8',
      timeout: CODEX_CLI_SHAPE_TIMEOUT_MS,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return { ok: true, output, message: '' };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    return {
      ok: false,
      output,
      message: stripAnsi(output || err.message || String(error)).trim(),
    };
  }
}

async function findExecutableInPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
