import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContextLayerError } from './context-layer-errors.js';

export const CONTEXT_LAYER_REFINER_PROFILE =
  'grepmind-context-layer-refiner';

const CODEX_MCP_LIST_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export async function verifyContextLayerRefinerProfile(
  codexBin: string,
  workspacePath: string,
): Promise<void> {
  const mcpList = await readCodexMcpList(codexBin, workspacePath);
  if (!mcpList.ok) {
    throw new ContextLayerError(
      'PROMPT_REFINER_PROFILE_INVALID',
      `Codex prompt-refiner profile ${CONTEXT_LAYER_REFINER_PROFILE} could not be checked with "codex mcp list --json". Configure a valid prompt-refiner profile. ${mcpList.message}`,
    );
  }
}

async function readCodexMcpList(
  codexBin: string,
  cwd: string,
): Promise<{ ok: boolean; output: string; message: string }> {
  try {
    const result = await execFileAsync(
      codexBin,
      [
        '--profile',
        CONTEXT_LAYER_REFINER_PROFILE,
        '--cd',
        cwd,
        'mcp',
        'list',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: CODEX_MCP_LIST_TIMEOUT_MS,
        env: {
          ...process.env,
          GREPMIND_CONTEXT_LAYER_SUBAGENT: '1',
          NO_COLOR: '1',
        },
      },
    );
    return { ok: true, output: result.stdout ?? '', message: '' };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const message = stripAnsi(
      `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() ||
        err.message ||
        String(error),
    ).trim();
    return { ok: false, output: '', message };
  }
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, '');
}
