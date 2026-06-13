import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LocalProjectRecord } from '@grepmind/agent-rpc';
import { createAgentConsole } from '../cli-context.js';
import {
  executeSocketPreferredCommand,
  deriveRepoFullNameFromRemoteUrl,
  resolveWorkspaceDefaultBranch,
  resolveWorkspacePath,
  resolveWorkspaceRemoteUrl,
} from '../command-support.js';
import { computeWorkspaceFingerprint } from '../config.js';
import {
  getStringFlag,
  hasBooleanFlag,
  requireIntegerFlag,
  requireStringFlag,
} from '../flags.js';
import type { ParsedArgs } from '../parse-args.js';
import { confirmCleanProjects } from '../prompt-confirmation.js';

export async function registerCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const workspacePath = await resolveWorkspacePath(
    requireStringFlag(args, 'workspace'),
  );
  const remoteUrl = await resolveWorkspaceRemoteUrl(workspacePath);
  const repoFullName = deriveRepoFullNameFromRemoteUrl(remoteUrl);
  const defaultBranch = await resolveWorkspaceDefaultBranch(workspacePath);
  const displayName = requireStringFlag(
    args,
    'display-name',
    path.basename(workspacePath),
  );
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspacePath);
  const preferredActiveBranch = getStringFlag(args, 'branch');
  const requestId = randomUUID();

  const result = await executeSocketPreferredCommand(args, {
    rpc: (client) =>
      client.registerProject({
        remoteUrl,
        repoFullName,
        defaultBranch,
        displayName,
        workspacePath,
        workspaceFingerprint,
        preferredActiveBranch,
        idempotencyKey: requestId,
      }),
  });
  if (result.registered === false) {
    const target = result.repoFullName ?? result.remoteIdentity;
    const message =
      result.githubAppRepair?.message ?? 'GitHub App access is required';
    agentConsole.info(
      'project',
      `Registration skipped for ${target}: ${message}`,
    );
    return;
  }

  agentConsole.success(
    'project',
    `Registered ${result.snapshot.project.displayName} as binding #${result.snapshot.project.bindingId} for ${result.snapshot.project.repoFullName}`,
  );
}

export async function listProjectsCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const result = await executeSocketPreferredCommand(args, {
    rpc: (client) => client.listProjects(),
  });

  if (result.items.length === 0) {
    agentConsole.info('project', 'No registered projects');
    return;
  }

  for (const project of result.items) {
    agentConsole.info(
      'project',
      `#${project.bindingId} ${project.displayName} -> ${project.repoFullName} (${project.workspacePath})`,
    );
  }
}

export async function removeProjectCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const bindingId = requireIntegerFlag(args, 'binding-id');
  const requestId = randomUUID();

  await executeSocketPreferredCommand(args, {
    rpc: (client) =>
      client.unbindProject({
        bindingId,
        idempotencyKey: requestId,
      }),
  });

  agentConsole.warn('project', `Removed binding #${bindingId}`);
}

export async function cleanProjectCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const targets = await executeSocketPreferredCommand(args, {
    rpc: async (client) => {
      const projects = await client.listProjects();
      return resolveProjectsForClean(args, projects.items);
    },
  });

  if (targets.length === 0) {
    agentConsole.info('project', 'No registered projects');
    return;
  }

  const confirmed = await confirmCleanProjects(targets);
  if (!confirmed) {
    agentConsole.info('project', 'Clean cancelled');
    return;
  }

  const cleanedProjects = await executeSocketPreferredCommand(args, {
    rpc: async (client) => {
      const cleaned: LocalProjectRecord[] = [];

      for (const target of targets) {
        const result = await client.cleanProject({
          bindingId: target.bindingId,
          idempotencyKey: randomUUID(),
        });
        cleaned.push(result.project);
      }

      return cleaned;
    },
  });

  if (cleanedProjects.length === 1) {
    const [project] = cleanedProjects;
    agentConsole.warn(
      'project',
      `Cleaned local project ${project.displayName} (${project.workspacePath})`,
    );
    return;
  }

  const workspacePath = cleanedProjects[0]!.workspacePath;
  const allSameWorkspace = cleanedProjects.every(
    (project) => project.workspacePath === workspacePath,
  );
  if (!allSameWorkspace) {
    agentConsole.warn(
      'project',
      `Cleaned ${cleanedProjects.length} local project registrations`,
    );
    return;
  }

  agentConsole.warn(
    'project',
    `Cleaned ${cleanedProjects.length} local project registrations for ${workspacePath}`,
  );
}

async function resolveProjectsForClean(
  args: ParsedArgs,
  items: LocalProjectRecord[],
): Promise<LocalProjectRecord[]> {
  if (getStringFlag(args, 'binding-id') != null) {
    throw new Error('clean does not support --binding-id; use --workspace');
  }

  const cleanAll = hasBooleanFlag(args, 'all') || hasBooleanFlag(args, 'a');
  const workspaceArg = getStringFlag(args, 'workspace');
  if (cleanAll) {
    if (workspaceArg) {
      throw new Error('clean does not support --workspace with --all');
    }

    return items;
  }

  if (!workspaceArg) {
    throw new Error('--workspace is required unless --all is set');
  }
  const workspacePath = await resolveWorkspacePath(workspaceArg);
  const matches = items.filter((item) => item.workspacePath === workspacePath);

  if (matches.length === 0) {
    throw new Error(
      `No local project is registered for workspace ${workspacePath}`,
    );
  }

  return matches;
}
