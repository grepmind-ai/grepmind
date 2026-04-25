import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LocalProjectRecord } from '@grepmind/agent-rpc';
import { createAgentConsole } from '../cli-context.js';
import {
  executeSocketPreferredCommand,
  resolveWorkspacePath,
  resolveWorkspaceRemoteFingerprint,
} from '../command-support.js';
import { computeWorkspaceFingerprint } from '../config.js';
import {
  getStringFlag,
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
  const remoteFingerprint =
    await resolveWorkspaceRemoteFingerprint(workspacePath);
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
        remoteFingerprint,
        displayName,
        workspacePath,
        workspaceFingerprint,
        preferredActiveBranch,
        idempotencyKey: requestId,
      }),
  });

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

  const workspaceArg = getStringFlag(args, 'workspace');
  if (!workspaceArg) {
    throw new Error('--workspace is required');
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
