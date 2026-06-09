import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveGitWorkspaceRoot(cwd = process.cwd()): Promise<string> {
  const candidate = path.resolve(cwd);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', candidate, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    const root = stdout.trim();
    if (!root) {
      throw new Error('git rev-parse returned empty output');
    }
    return path.resolve(root);
  } catch (error) {
    throw new Error(
      `grepmind init requires a project-local Git workspace. Failed to resolve Git root for ${candidate}: ${formatError(error)}`,
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
