import type { SearchTarget } from '../backend/contracts/index.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { LocalProjectRecord, LocalProjectSnapshot } from '../db/schema.js';
import type { SyncProjectResult } from '../services/project-sync-service.js';
import type { RegisterLocalProjectInput } from '../services/project-registry-service.js';
import {
  loadAgentStatusSnapshot,
  type AgentStatusQuery,
  type AgentStatusSnapshot,
} from './status-query.js';

export type { AgentStatusQuery, AgentStatusSnapshot } from './status-query.js';

export interface RegisterProjectCommandResult {
  snapshot: LocalProjectSnapshot;
  projectionVersion: number;
}

export interface ListProjectsCommandResult {
  items: LocalProjectRecord[];
}

export interface SyncProjectCommandInput {
  bindingId?: number;
  targets?: SearchTarget[];
}

export interface SyncProjectCommandResult {
  results: SyncProjectResult[];
}

export interface CleanProjectCommandResult {
  project: LocalProjectRecord;
}

export class AgentCommandExecutor {
  constructor(private readonly runtime: AgentRuntime) {}

  async registerProject(input: RegisterLocalProjectInput): Promise<RegisterProjectCommandResult> {
    const snapshot = await this.runtime.projects.registerProject(input);

    return {
      snapshot,
      projectionVersion: toProjectionVersion(snapshot.project.updatedAt),
    };
  }

  async listProjects(): Promise<ListProjectsCommandResult> {
    return {
      items: await this.runtime.projects.listProjects(),
    };
  }

  async syncProject(input: SyncProjectCommandInput = {}): Promise<SyncProjectCommandResult> {
    if (input.bindingId != null) {
      return {
        results: [
          await this.runtime.sync.syncProject(input.bindingId, {
            targets: input.targets,
          }),
        ],
      };
    }

    return {
      results: await this.runtime.sync.syncAllProjects({
        targets: input.targets,
      }),
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
}

function toProjectionVersion(updatedAt: string): number {
  const value = Date.parse(updatedAt);
  return Number.isFinite(value) ? value : Date.now();
}
