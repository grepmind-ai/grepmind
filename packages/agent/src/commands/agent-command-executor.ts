import type {
  AgentStatusQuery,
  AgentStatusSnapshot,
  CleanProjectCommandResult,
  ListProjectsCommandResult,
  RegisterProjectCommandResult,
  SearchTarget,
  SyncProjectCommandResult,
} from '@grepmind/agent-rpc';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { RegisterLocalProjectInput } from '../services/project-registry-service.js';
import { loadAgentStatusSnapshot } from './status-query.js';

export type {
  AgentStatusQuery,
  AgentStatusSnapshot,
} from '@grepmind/agent-rpc';

export interface SyncProjectCommandInput {
  bindingId?: number;
  targets?: SearchTarget[];
}

export interface AgentCommandExecutorOptions {
  syncHead?: (bindingId: number) => Promise<void>;
}

export class AgentCommandExecutor {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly options: AgentCommandExecutorOptions = {},
  ) {}

  async registerProject(
    input: RegisterLocalProjectInput,
  ): Promise<RegisterProjectCommandResult> {
    const result = await this.runtime.projects.registerProject(input);
    if (!('snapshot' in result)) {
      return result;
    }

    return {
      snapshot: result.snapshot,
      projectionVersion: toProjectionVersion(result.snapshot.project.updatedAt),
    };
  }

  async listProjects(): Promise<ListProjectsCommandResult> {
    return {
      items: await this.runtime.projects.listProjects(),
    };
  }

  async syncProject(
    input: SyncProjectCommandInput = {},
  ): Promise<SyncProjectCommandResult> {
    if (input.bindingId != null) {
      await this.syncHead(input.bindingId);
      return {
        results: [
          await this.runtime.sync.syncProject(input.bindingId, {
            targets: input.targets,
          }),
        ],
      };
    }

    const projects = await this.runtime.projects.listProjects();
    const results: SyncProjectCommandResult['results'] = [];
    for (const project of projects) {
      await this.syncHead(project.bindingId);
      results.push(
        await this.runtime.sync.syncProject(project.bindingId, {
          targets: input.targets,
        }),
      );
    }

    return {
      results,
    };
  }

  async unbindProject(bindingId: number): Promise<void> {
    await this.runtime.projects.unregisterProject(bindingId);
  }

  async cleanProject(bindingId: number): Promise<CleanProjectCommandResult> {
    return {
      project: await this.runtime.projects.cleanProject(bindingId),
    };
  }

  async status(input: AgentStatusQuery = {}): Promise<AgentStatusSnapshot> {
    return loadAgentStatusSnapshot(this.runtime.db, input);
  }

  private async syncHead(bindingId: number): Promise<void> {
    await this.options.syncHead?.(bindingId);
  }
}

function toProjectionVersion(updatedAt: string): number {
  const value = Date.parse(updatedAt);
  return Number.isFinite(value) ? value : Date.now();
}
