import { setTimeout as delay } from 'node:timers/promises';
import { AgentBackendRealtimeClient } from '../backend/agent-backend-realtime-client.js';
import type {
  BootstrapResponse,
  SearchRequestPayload,
  SearchResponsePayload,
} from '../backend/contracts/index.js';
import {
  createAgentRuntime,
  type AgentRuntime,
} from '../runtime/agent-runtime.js';
import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';
import { RevisionPublicationService } from '../services/revision-publication-service.js';
import type { AgentCliConfig } from './config.js';
import { toBackendOptions } from './config.js';

export interface AgentRunLoopOptions {
  logger?: AgentLogger;
  bootstrapOnInit?: boolean;
  onStopRequested?: () => void;
}

export class AgentRunner {
  private readonly logger: AgentLogger;
  private readonly bootstrapOnInit: boolean;
  private readonly onStopRequested?: () => void;
  private runtime: AgentRuntime | null = null;
  private revisionPublication: RevisionPublicationService | null = null;
  private realtimeClient: AgentBackendRealtimeClient | null = null;
  private bootstrap: BootstrapResponse | null = null;
  private stopping = false;
  private sleepController: AbortController | null = null;
  private readonly nextSyncAtByBinding = new Map<number, number>();
  private loggedNoProjects = false;
  private iteration = 0;

  constructor(
    private readonly config: AgentCliConfig,
    options: AgentRunLoopOptions = {},
  ) {
    this.logger = options.logger ?? noopAgentLogger;
    this.bootstrapOnInit = options.bootstrapOnInit ?? true;
    this.onStopRequested = options.onStopRequested;
  }

  async start(): Promise<void> {
    if (this.runtime) {
      return;
    }

    const backendOptions = toBackendOptions(this.config, this.logger);
    this.runtime = await createAgentRuntime({
      dataDir: this.config.dataDir,
      backend: backendOptions,
      bootstrapOnInit: this.bootstrapOnInit,
    });
    this.bootstrap = await this.runtime.bootstrap();
    this.revisionPublication = new RevisionPublicationService({
      backend: this.runtime.backend,
      projectRegistry: this.runtime.projects,
      deviceId: this.config.deviceId,
      deviceName: this.config.name,
      logger: this.logger,
    });
    if (this.bootstrap.supportedFeatures.agentWebSocket) {
      const runtime = this.runtime;
      this.realtimeClient = new AgentBackendRealtimeClient({
        baseUrl: this.config.apiBaseUrl,
        accessToken: backendOptions.accessToken,
        accountSession: backendOptions.accountSession,
        deviceId: this.config.deviceId,
        deviceName: this.config.name,
        heartbeatMs: this.bootstrap.defaultWebSocketHeartbeatMs,
        reconnectBaseMs: this.bootstrap.defaultWebSocketReconnectBaseMs,
        logger: this.logger,
        capabilities: { sourceTransport: 'snapshot' },
        onIndexSearchRequested: (payload) => runtime.search.search(payload),
        onStopRequested: () => {
          this.requestStop();
          this.onStopRequested?.();
        },
      });
      const initialProjects = await this.runtime.projects.listProjects();
      this.realtimeClient.start(this.getRealtimeBindings(initialProjects));
    }
  }

  async runOnce(): Promise<void> {
    const runtime = await this.requireRuntime();
    const revisionPublication = await this.requireRevisionPublication();
    const projects = await runtime.projects.listProjects();
    this.iteration += 1;
    this.syncRealtimeBindings(projects);

    this.logger.trace(
      'runtime',
      `runOnce.start iteration=${this.iteration} projects=${projects.length} stopping=${this.stopping}`,
    );

    if (projects.length === 0) {
      if (!this.loggedNoProjects) {
        this.logger.info(
          'project',
          'No registered projects; waiting for the next poll',
        );
        this.loggedNoProjects = true;
      }
      revisionPublication.dropMissingBindings(new Set<number>());
      this.syncRealtimeBindings([]);
      return;
    }

    this.loggedNoProjects = false;
    const activeBindingIds = new Set<number>();

    for (const project of projects) {
      if (this.stopping) {
        this.logger.trace(
          'runtime',
          `runOnce.stop-requested iteration=${this.iteration}`,
        );
        return;
      }

      activeBindingIds.add(project.bindingId);

      try {
        await revisionPublication.ensureAttachedAndSyncHead(project.bindingId);
      } catch (error) {
        this.logger.error(
          'publish',
          `Head sync failed for ${project.displayName} (#${project.bindingId})`,
          error,
        );
      }

      if (!this.shouldSyncProject(project.bindingId)) {
        this.logger.trace(
          'sync',
          `skipped iteration=${this.iteration} bindingId=${project.bindingId}`,
        );
        continue;
      }

      this.logger.info(
        'sync',
        `Syncing ${project.displayName} (#${project.bindingId})`,
      );
      try {
        const result = await runtime.sync.syncProject(project.bindingId);
        if (isIdleSyncResult(result)) {
          this.logger.info(
            'sync',
            `No new sync deltas for ${project.displayName} (#${project.bindingId})`,
          );
        } else {
          this.logger.success(
            'sync',
            `Synced ${project.displayName} (#${project.bindingId}): revisions=${result.revisionCount}, materializations=${result.materializedPlanCount}, invalidations=${result.invalidationCount}`,
          );
        }
      } catch (error) {
        this.logger.error(
          'sync',
          `Sync failed for ${project.displayName} (#${project.bindingId})`,
          error,
        );
      } finally {
        this.scheduleNextSync(project.bindingId);
      }
    }

    revisionPublication.dropMissingBindings(activeBindingIds);
    for (const bindingId of this.nextSyncAtByBinding.keys()) {
      if (!activeBindingIds.has(bindingId)) {
        this.nextSyncAtByBinding.delete(bindingId);
      }
    }
    this.syncRealtimeBindings(projects);

    this.logger.trace(
      'runtime',
      `runOnce.done iteration=${this.iteration} activeBindings=${activeBindingIds.size}`,
    );
  }

  async runLoop(): Promise<void> {
    await this.start();
    this.logger.info(
      'runtime',
      `Agent ${this.config.name} is running with sync poll interval ${this.config.pollIntervalMs}ms and head sync poll interval ${this.config.headPollIntervalMs}ms`,
    );

    while (!this.stopping) {
      await this.runOnce();

      if (this.stopping) {
        break;
      }

      this.sleepController = new AbortController();
      try {
        await delay(this.config.headPollIntervalMs, undefined, {
          signal: this.sleepController.signal,
        });
      } catch (error) {
        if (!isAbortError(error)) {
          throw error;
        }
      } finally {
        this.sleepController = null;
      }
    }
  }

  async stop(): Promise<void> {
    this.requestStop();
    this.logger.trace('runtime', 'runner.stop requested');
    await this.realtimeClient?.stop().catch((error) => {
      this.logger.error(
        'runtime',
        'Failed to stop realtime client cleanly',
        error,
      );
    });
    this.realtimeClient = null;
    if (this.runtime) {
      await this.runtime.close();
      this.runtime = null;
    }
    this.revisionPublication = null;
    this.nextSyncAtByBinding.clear();
    this.loggedNoProjects = false;
  }

  requestStop(): void {
    this.stopping = true;
    this.sleepController?.abort();
    void this.realtimeClient?.stop();
  }

  async getRuntime(): Promise<AgentRuntime> {
    return this.requireRuntime();
  }

  async search(
    input: SearchRequestPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<SearchResponsePayload> {
    if (!this.realtimeClient) {
      throw new Error('Agent realtime transport is not available');
    }

    return this.realtimeClient.runSearch(input, options);
  }

  async syncHead(bindingId: number): Promise<void> {
    const revisionPublication = await this.requireRevisionPublication();
    await revisionPublication.ensureAttachedAndSyncHead(bindingId);
  }

  private async requireRuntime(): Promise<AgentRuntime> {
    if (!this.runtime) {
      await this.start();
    }

    if (!this.runtime) {
      throw new Error('Agent runtime failed to start');
    }

    return this.runtime;
  }

  private async requireRevisionPublication(): Promise<RevisionPublicationService> {
    if (!this.revisionPublication) {
      await this.start();
    }

    if (!this.revisionPublication) {
      throw new Error('Revision publication service failed to initialize');
    }

    return this.revisionPublication;
  }

  private shouldSyncProject(bindingId: number): boolean {
    const nextSyncAt = this.nextSyncAtByBinding.get(bindingId);
    return nextSyncAt == null || Date.now() >= nextSyncAt;
  }

  private scheduleNextSync(bindingId: number): void {
    this.nextSyncAtByBinding.set(
      bindingId,
      Date.now() + this.config.pollIntervalMs,
    );
  }

  private getRealtimeBindings(
    projects: Array<{ bindingId: number }>,
  ): Array<{ bindingId: number; attachEpoch?: number }> {
    if (!this.revisionPublication) {
      return projects.map((project) => ({ bindingId: project.bindingId }));
    }

    return this.revisionPublication.listBindingSubscriptions(
      projects.map((project) => project.bindingId),
    );
  }

  private syncRealtimeBindings(projects: Array<{ bindingId: number }>): void {
    this.realtimeClient?.updateBindings(this.getRealtimeBindings(projects));
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isIdleSyncResult(result: {
  revisionCount: number;
  materializedPlanCount: number;
  invalidationCount: number;
}): boolean {
  return (
    result.revisionCount === 0 &&
    result.materializedPlanCount === 0 &&
    result.invalidationCount === 0
  );
}
