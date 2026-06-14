import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ObservedLocalHead {
  branch: string;
  headCommitSha: string;
  remoteFingerprint: string;
  agentRepoRef: string;
  observedAt: string;
}

export interface ObservedLocalSource {
  remoteFingerprint: string;
  agentRepoRef: string;
}

export class LocalHeadService {
  async readObservedSource(
    workspacePath: string,
  ): Promise<ObservedLocalSource> {
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const origin = await this.runGit(
      resolvedWorkspacePath,
      ['remote', 'get-url', 'origin'],
      'origin remote is not configured',
    );
    const normalizedRemoteFingerprint = normalizeRemoteFingerprint(origin);
    if (!normalizedRemoteFingerprint) {
      throw new Error(
        `Remote fingerprint is empty for workspace: ${resolvedWorkspacePath}`,
      );
    }

    return {
      remoteFingerprint: normalizedRemoteFingerprint,
      agentRepoRef: resolvedWorkspacePath,
    };
  }

  async readObservedHead(
    workspacePath: string,
  ): Promise<ObservedLocalHead | null> {
    const observedSource = await this.readObservedSource(workspacePath);
    const branch = await this.runGit(
      observedSource.agentRepoRef,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      'failed to resolve current branch from HEAD',
    );

    if (branch === 'HEAD') {
      return null;
    }

    const headCommitSha = await this.runGit(
      observedSource.agentRepoRef,
      ['rev-parse', 'HEAD'],
      'failed to resolve HEAD commit',
    );

    const normalizedHeadCommitSha = normalizeCommitSha(headCommitSha);

    return {
      branch,
      headCommitSha: normalizedHeadCommitSha,
      remoteFingerprint: observedSource.remoteFingerprint,
      agentRepoRef: observedSource.agentRepoRef,
      observedAt: new Date().toISOString(),
    };
  }

  private async runGit(
    workspacePath: string,
    args: string[],
    context: string,
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: workspacePath,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });

      const output = stdout.trim();
      if (!output) {
        throw new Error(`git ${args.join(' ')} returned empty output`);
      }

      return output;
    } catch (error) {
      throw new Error(
        `${context} in ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function normalizeCommitSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]+$/.test(normalized) ||
    (normalized.length !== 40 && normalized.length !== 64)
  ) {
    throw new Error('commit sha must be a full 40 or 64 character hex string');
  }

  return normalized;
}

function normalizeRemoteFingerprint(value: string): string {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/\.git$/, '');
  normalized = normalized.replace(/^ssh:\/\//, '');
  if (normalized.startsWith('git@')) {
    normalized = normalized.slice(4).replace(':', '/');
  }
  normalized = normalized.replace(/^[a-z]+:\/\//, '');
  return normalized;
}
