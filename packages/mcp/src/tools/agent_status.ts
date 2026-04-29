import {
  getAgentAuthStatus,
  isRuntimeUnavailableError,
} from '@grepmind/agent-rpc';
import { z } from 'zod';
import {
  getMcpWorkspaceContext,
  getReadyAgentRuntimeClient,
} from '../runtime-context.js';

export const agentStatusSchema = z.object({}).strict();

export async function agentStatusTool(): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const context = getMcpWorkspaceContext();
  const client = getReadyAgentRuntimeClient();
  const auth = await getAgentAuthStatus(context.dataDir);

  try {
    const [runtime, projects, status] = await Promise.all([
      client.ping(),
      client.listProjects(),
      client.status({ bindingId: context.bindingId, limit: 20 }),
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
        needsLogin: auth.needsLogin,
        host: auth.host,
        apiBaseUrl: auth.apiBaseUrl,
        accountEmail: auth.accountEmail,
        expiresAt: auth.expiresAt,
        expired: auth.expired,
      },
      runtime: {
        running: true,
        protocolVersion: runtime.protocolVersion,
        instanceId: runtime.instanceId,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        dataDir: runtime.dataDir,
      },
      project,
      lastSyncStatus: {
        lastSyncedAt: project.lastSyncedAt,
        activeBranch: project.activeBranch,
        defaultBranch: project.defaultBranch,
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
            needsLogin: auth.needsLogin,
            host: auth.host,
            apiBaseUrl: auth.apiBaseUrl,
            accountEmail: auth.accountEmail,
            expiresAt: auth.expiresAt,
            expired: auth.expired,
          },
          runtime: {
            running: false,
            error: error instanceof Error ? error.message : String(error),
          },
          project: context.project,
          lastSyncStatus: null,
        },
        true,
      );
    }

    throw error;
  }
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
