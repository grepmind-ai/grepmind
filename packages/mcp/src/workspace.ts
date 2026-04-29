import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface McpCliOptions {
  workspace?: string;
}

export function parseMcpCliArgs(argv: string[]): McpCliOptions {
  const options: McpCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--workspace') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--workspace requires a path');
      }
      setWorkspace(options, value);
      index += 1;
      continue;
    }

    if (token.startsWith('--workspace=')) {
      const value = token.slice('--workspace='.length);
      if (!value) {
        throw new Error('--workspace requires a path');
      }
      setWorkspace(options, value);
      continue;
    }

    if (token === '--help' || token === '-h') {
      throw new Error(
        'Usage: grepmind-mcp [--workspace <path>]. Configure this as a project-local MCP server.',
      );
    }

    throw new Error(`Unknown grepmind-mcp argument: ${token}`);
  }

  return options;
}

export async function resolveWorkspaceRoot(
  workspacePathInput?: string,
): Promise<string> {
  const candidate = path.resolve(workspacePathInput ?? process.cwd());

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
      `Grepmind MCP requires a project-local Git workspace. Configure your MCP client with args ["--workspace", "\${workspaceFolder}"], or launch grepmind-mcp with cwd set to a Git workspace root. Failed to resolve Git root for ${candidate}: ${formatError(error)}`,
    );
  }
}

function setWorkspace(options: McpCliOptions, value: string): void {
  if (options.workspace != null) {
    throw new Error('--workspace may only be provided once');
  }

  options.workspace = value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
