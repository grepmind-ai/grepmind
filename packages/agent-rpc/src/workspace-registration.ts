import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { AgentRuntimeClient } from './client.js';
import type {
  LocalProjectRecord,
  RegisterProjectSkippedCommandResult,
} from './protocol.js';

const execFileAsync = promisify(execFile);

export interface EnsureWorkspaceRegisteredOptions {
  client: AgentRuntimeClient;
  workspacePath: string;
  displayName?: string;
  preferredActiveBranch?: string;
  idempotencyPrefix?: string;
  timeoutMs?: number;
}

export async function ensureWorkspaceRegistered(
  options: EnsureWorkspaceRegisteredOptions,
): Promise<LocalProjectRecord> {
  const workspacePath = path.resolve(options.workspacePath);
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspacePath);
  const matchingProject = await findUniqueRegisteredProject({
    client: options.client,
    workspacePath,
    workspaceFingerprint,
    timeoutMs: options.timeoutMs,
  });

  if (matchingProject) {
    return matchingProject;
  }

  const metadata = await collectWorkspaceRegistrationMetadata({
    workspacePath,
    workspaceFingerprint,
    displayName: options.displayName,
    preferredActiveBranch: options.preferredActiveBranch,
  });
  const idempotencyMaterial = `${workspaceFingerprint}\0${metadata.remoteUrl}`;
  const idempotencyPrefix = options.idempotencyPrefix ?? 'workspace-register';
  const idempotencyKey = `${idempotencyPrefix}:${sha256(idempotencyMaterial)}`;

  try {
    const result = await options.client.registerProject(
      {
        ...metadata,
        idempotencyKey,
      },
      { timeoutMs: options.timeoutMs },
    );
    if (result.registered === false) {
      throw new Error(formatSkippedRegistration(result));
    }
    return result.snapshot.project;
  } catch (error) {
    throw new Error(
      `Grepmind could not register workspace ${workspacePath}: ${formatError(error)}`,
    );
  }
}

function formatSkippedRegistration(
  result: RegisterProjectSkippedCommandResult,
): string {
  const target = result.repoFullName ?? result.remoteIdentity;
  const message =
    result.githubAppRepair?.message ?? 'GitHub App access is required';
  return `registration skipped for ${target}: ${message}`;
}

async function findUniqueRegisteredProject(input: {
  client: AgentRuntimeClient;
  workspacePath: string;
  workspaceFingerprint: string;
  timeoutMs?: number;
}): Promise<LocalProjectRecord | null> {
  const startupRealpath = await realpath(input.workspacePath);
  const projects = await input.client.listProjects({
    timeoutMs: input.timeoutMs,
  });
  const matches = new Map<number, LocalProjectRecord>();

  for (const project of projects.items) {
    if (
      await matchesRegisteredWorkspace(project, {
        workspacePath: input.workspacePath,
        workspaceRealpath: startupRealpath,
        workspaceFingerprint: input.workspaceFingerprint,
      })
    ) {
      matches.set(project.bindingId, project);
    }
  }

  const uniqueMatches = [...matches.values()];
  if (uniqueMatches.length === 0) {
    return null;
  }
  if (uniqueMatches.length === 1) {
    return uniqueMatches[0]!;
  }

  throw new Error(
    `Grepmind found multiple local project bindings for ${input.workspacePath}: ${uniqueMatches.map((project) => `#${project.bindingId}`).join(', ')}. Clean or unbind duplicate bindings manually and retry.`,
  );
}

async function matchesRegisteredWorkspace(
  project: LocalProjectRecord,
  workspace: {
    workspacePath: string;
    workspaceRealpath: string;
    workspaceFingerprint: string;
  },
): Promise<boolean> {
  if (path.resolve(project.workspacePath) === workspace.workspacePath) {
    return true;
  }

  if (project.workspaceFingerprint === workspace.workspaceFingerprint) {
    return true;
  }

  try {
    return (
      (await realpath(project.workspacePath)) === workspace.workspaceRealpath
    );
  } catch {
    return false;
  }
}

async function collectWorkspaceRegistrationMetadata(input: {
  workspacePath: string;
  workspaceFingerprint: string;
  displayName?: string;
  preferredActiveBranch?: string;
}): Promise<{
  remoteUrl: string;
  repoFullName?: string;
  defaultBranch?: string;
  displayName: string;
  workspacePath: string;
  workspaceFingerprint: string;
  preferredActiveBranch?: string;
}> {
  let remoteUrl: string;
  try {
    remoteUrl = await resolveWorkspaceRemoteUrl(input.workspacePath);
  } catch (error) {
    throw new Error(
      `Workspace ${input.workspacePath} is not registered and does not have a readable origin remote, so Grepmind cannot auto-register it. Configure origin, then retry or register this workspace manually. ${formatError(error)}`,
    );
  }

  return {
    remoteUrl,
    repoFullName: deriveRepoFullNameFromRemoteUrl(remoteUrl),
    defaultBranch: await resolveWorkspaceDefaultBranch(input.workspacePath),
    displayName: input.displayName ?? path.basename(input.workspacePath),
    workspacePath: input.workspacePath,
    workspaceFingerprint: input.workspaceFingerprint,
    preferredActiveBranch:
      input.preferredActiveBranch ??
      (await resolveCurrentBranch(input.workspacePath)),
  };
}

async function computeWorkspaceFingerprint(
  workspacePath: string,
): Promise<string> {
  const resolved = await realpath(workspacePath);
  const info = await stat(resolved);
  const hash = createHash('sha256');
  hash.update(resolved);
  hash.update(':');
  hash.update(String(info.dev));
  hash.update(':');
  hash.update(String(info.ino));
  return hash.digest('hex');
}

async function resolveWorkspaceRemoteUrl(
  workspacePath: string,
): Promise<string> {
  const remote = await runGit(workspacePath, ['remote', 'get-url', 'origin']);
  if (!remote) {
    throw new Error('git remote get-url origin returned empty output');
  }
  return remote;
}

async function resolveWorkspaceDefaultBranch(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    const remoteHead = await runGit(workspacePath, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    const branch = remoteHead.startsWith('origin/')
      ? remoteHead.slice('origin/'.length)
      : remoteHead;
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function resolveCurrentBranch(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    const branch = await runGit(workspacePath, ['branch', '--show-current']);
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspacePath, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );

  return stdout.trim();
}

function deriveRepoFullNameFromRemoteUrl(
  remoteUrl: string,
): string | undefined {
  const parsed = parseRemoteUrlPath(remoteUrl);
  if (!parsed || parsed.pathSegments.length !== 2) {
    return undefined;
  }

  return parsed.pathSegments.join('/');
}

function parseRemoteUrlPath(
  remoteUrl: string,
): { pathSegments: string[] } | null {
  const raw = remoteUrl.trim();
  const scp = /^(?:[A-Za-z0-9._-]+)@(?<host>[^:/\s]+):(?<path>[^?#\s]+)$/.exec(
    raw,
  );
  if (scp?.groups?.path && !/^\d+\//.test(scp.groups.path)) {
    return normalizeRemotePath(scp.groups.path);
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.search || url.hash || url.password) {
      return null;
    }
    if (url.protocol === 'https:' && url.username) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
      return null;
    }
    return normalizeRemotePath(url.pathname);
  } catch {
    return null;
  }
}

function normalizeRemotePath(
  pathname: string,
): { pathSegments: string[] } | null {
  const trimmed = pathname.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const withoutGit = trimmed.replace(/\.git$/i, '');
  const pathSegments = withoutGit
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  return pathSegments.length >= 2 ? { pathSegments } : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
