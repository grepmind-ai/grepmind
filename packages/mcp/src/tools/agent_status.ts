import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getAgentAuthStatus,
  isRuntimeUnavailableError,
} from '@grepmind/agent-rpc';
import { z } from 'zod';
import {
  ensureMcpRuntimePrepared,
  getMcpWorkspaceContext,
  getReadyAgentRuntimeClient,
} from '../runtime-context.js';

const execFileAsync = promisify(execFile);

export const agentStatusSchema = z.object({}).strict();

export async function agentStatusTool(): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    await ensureMcpRuntimePrepared();
  } catch (error) {
    return jsonResponse(
      {
        runtime: {
          running: false,
          error: error instanceof Error ? error.message : String(error),
        },
      },
      true,
    );
  }

  const context = getMcpWorkspaceContext();
  const client = getReadyAgentRuntimeClient();
  const auth = await getAgentAuthStatus(context.dataDir);
  const localHead = await readLocalHead(context.workspacePath);

  try {
    const [runtime, projects, status, localHeadStatus] = await Promise.all([
      client.ping(),
      client.listProjects(),
      client.status({ bindingId: context.bindingId, limit: 20 }),
      localHead.branch && localHead.headCommitSha
        ? client.status({
            bindingId: context.bindingId,
            branch: localHead.branch,
            commitSha: localHead.headCommitSha,
            limit: 20,
          })
        : Promise.resolve(null),
    ]);
    const project =
      projects.items.find((item) => item.bindingId === context.bindingId) ??
      context.project;

    return jsonResponse({
      workspacePath: context.workspacePath,
      bindingId: context.bindingId,
      dataDir: context.dataDir,
      auth: {
        loggedIn: auth.loggedIn,
        credentialStatus: auth.credentialStatus,
        accountSessionStatus: auth.accountSessionStatus,
        needsLogin: auth.needsLogin,
        host: auth.host,
        apiBaseUrl: auth.apiBaseUrl,
        accountEmail: auth.accountEmail,
        expiresAt: auth.expiresAt,
        expired: auth.expired,
        selectedAccountId: auth.selectedAccountId,
        selectedAccountName: auth.selectedAccountName,
        accountSessionExpiresAt: auth.accountSessionExpiresAt,
      },
      runtime: {
        running: true,
        protocolVersion: runtime.protocolVersion,
        instanceId: runtime.instanceId,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        dataDir: runtime.dataDir,
      },
      project: omitActiveBranch(project),
      lastSyncStatus: {
        lastSyncedAt: project.lastSyncedAt,
        defaultBranch: project.defaultBranch,
        localHead,
        localHeadSnapshot: localHeadStatus,
        latestPayload: status.payloads[0] ?? null,
        latestMaterializations: status.materializations.slice(0, 5),
        latestAttachments: status.attachments.slice(0, 5),
      },
    });
  } catch (error) {
    if (isRuntimeUnavailableError(error)) {
      return jsonResponse(
        {
          workspacePath: context.workspacePath,
          bindingId: context.bindingId,
          dataDir: context.dataDir,
          auth: {
            loggedIn: auth.loggedIn,
            credentialStatus: auth.credentialStatus,
            accountSessionStatus: auth.accountSessionStatus,
            needsLogin: auth.needsLogin,
            host: auth.host,
            apiBaseUrl: auth.apiBaseUrl,
            accountEmail: auth.accountEmail,
            expiresAt: auth.expiresAt,
            expired: auth.expired,
            selectedAccountId: auth.selectedAccountId,
            selectedAccountName: auth.selectedAccountName,
            accountSessionExpiresAt: auth.accountSessionExpiresAt,
          },
          runtime: {
            running: false,
            error: error instanceof Error ? error.message : String(error),
          },
          project: omitActiveBranch(context.project),
          lastSyncStatus: {
            localHead,
          },
        },
        true,
      );
    }

    throw error;
  }
}

function omitActiveBranch<T extends { activeBranch?: unknown }>(
  project: T,
): Omit<T, 'activeBranch'> {
  const result: Partial<T> = { ...project };
  delete result.activeBranch;
  return result as Omit<T, 'activeBranch'>;
}

async function readLocalHead(workspacePath: string): Promise<{
  branch: string | null;
  headCommitSha: string | null;
  detached: boolean;
  error?: string;
}> {
  try {
    const branch = await runGit(workspacePath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    if (branch === 'HEAD') {
      return {
        branch: null,
        headCommitSha: null,
        detached: true,
      };
    }

    const headCommitSha = await runGit(workspacePath, ['rev-parse', 'HEAD']);
    return {
      branch,
      headCommitSha,
      detached: false,
    };
  } catch (error) {
    return {
      branch: null,
      headCommitSha: null,
      detached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
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
}

function jsonResponse(
  payload: unknown,
  isError = false,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
