import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import type { AgentControlCommand } from '@grepmind/agent-rpc';

export interface BundledAgentCommand extends AgentControlCommand {
  entrypointPath: string;
}

export async function resolveBundledAgentCommand(): Promise<BundledAgentCommand> {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(import.meta.url).resolve(
      '@grepmind/agent/package.json',
    );
  } catch (error) {
    throw new Error(
      `Grepmind installation is incomplete: bundled @grepmind/agent package was not found. Reinstall grepmind. ${formatError(error)}`,
    );
  }

  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as Partial<{
    bin: Record<string, string> | string;
  }>;
  const bin =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.['grepmind-agent'];

  if (!bin || typeof bin !== 'string') {
    throw new Error(
      'Grepmind installation is incomplete: bundled @grepmind/agent does not declare a grepmind-agent bin. Reinstall grepmind.',
    );
  }

  const entrypointPath = path.resolve(packageRoot, bin);
  try {
    await access(entrypointPath);
  } catch (error) {
    throw new Error(
      `Grepmind installation is incomplete: bundled agent entrypoint was not found at ${entrypointPath}. Reinstall grepmind. ${formatError(error)}`,
    );
  }

  return {
    command: process.execPath,
    baseArgs: [entrypointPath],
    entrypointPath,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
