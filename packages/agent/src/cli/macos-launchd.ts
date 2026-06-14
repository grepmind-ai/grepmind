import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_AGENT_LAUNCHD_LABELS = [
  'grepmind-agent-codex',
  'grepmind-agent',
] as const;
const LAUNCHCTL_PRINT_TIMEOUT_MS = 2_000;
const LAUNCHCTL_REMOVE_TIMEOUT_MS = 5_000;

export interface MacosLaunchdCleanupResult {
  removedLabels: string[];
  warnings: string[];
}

interface LaunchctlPrintResult {
  output: string | null;
  warning?: string;
}

export async function removeMacosLaunchdRuntimeSupervisor(
  dataDir: string,
): Promise<MacosLaunchdCleanupResult> {
  const result: MacosLaunchdCleanupResult = {
    removedLabels: [],
    warnings: [],
  };

  if (process.platform !== 'darwin') {
    return result;
  }

  const uid = process.getuid?.();
  if (uid == null) {
    result.warnings.push(
      'Cannot inspect macOS launchd runtime supervisor without a user id.',
    );
    return result;
  }

  const expectedDataDir = path.resolve(dataDir);
  for (const label of resolveCandidateLabels()) {
    const printResult = await printLaunchdJob(uid, label);
    if (printResult.warning) {
      result.warnings.push(printResult.warning);
    }
    if (!printResult.output) {
      continue;
    }
    if (!isRuntimeSupervisorForDataDir(printResult.output, expectedDataDir)) {
      continue;
    }

    try {
      await execFileAsync('launchctl', ['remove', label], {
        timeout: LAUNCHCTL_REMOVE_TIMEOUT_MS,
      });
      result.removedLabels.push(label);
    } catch (error) {
      result.warnings.push(
        `Failed to remove macOS launchd runtime supervisor "${label}"; the agent may restart after stop. ${formatExecError(error)}`,
      );
    }
  }

  return result;
}

function resolveCandidateLabels(): string[] {
  const configuredLabels =
    process.env.GREPMIND_AGENT_LAUNCHD_LABELS?.split(',')
      .map((label) => label.trim())
      .filter(Boolean) ?? [];
  return Array.from(
    new Set([...configuredLabels, ...DEFAULT_AGENT_LAUNCHD_LABELS]),
  );
}

async function printLaunchdJob(
  uid: number,
  label: string,
): Promise<LaunchctlPrintResult> {
  try {
    const { stdout } = await execFileAsync(
      'launchctl',
      ['print', `gui/${uid}/${label}`],
      {
        timeout: LAUNCHCTL_PRINT_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
      },
    );
    return { output: stdout };
  } catch (error) {
    const message = formatExecError(error);
    if (/Could not find service|Bad request/i.test(message)) {
      return { output: null };
    }
    return {
      output: null,
      warning: `Failed to inspect macOS launchd runtime supervisor "${label}". ${message}`,
    };
  }
}

function isRuntimeSupervisorForDataDir(
  launchctlOutput: string,
  expectedDataDir: string,
): boolean {
  if (!/\bkeepalive\b/i.test(launchctlOutput)) {
    return false;
  }

  const args = extractLaunchctlArguments(launchctlOutput);
  const dataDirFlagIndex = args.indexOf('--data-dir');
  const actualDataDir =
    dataDirFlagIndex >= 0 ? args[dataDirFlagIndex + 1] : undefined;

  return (
    args.includes('run') &&
    actualDataDir != null &&
    path.resolve(actualDataDir) === expectedDataDir
  );
}

function extractLaunchctlArguments(launchctlOutput: string): string[] {
  const args: string[] = [];
  let inArguments = false;

  for (const rawLine of launchctlOutput.split('\n')) {
    const line = rawLine.trim();
    if (line === 'arguments = {') {
      inArguments = true;
      continue;
    }
    if (!inArguments) {
      continue;
    }
    if (line === '}') {
      break;
    }
    if (line) {
      args.push(line);
    }
  }

  return args;
}

function formatExecError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const record = error as {
    message?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  const output = [record.stderr, record.stdout]
    .map((value) => (Buffer.isBuffer(value) ? value.toString('utf8') : value))
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n')
    .trim();

  return output || record.message || String(error);
}
