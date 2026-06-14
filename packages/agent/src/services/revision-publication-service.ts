import type { AgentBackendClient } from '../backend/agent-backend-client.js';
import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';
import { LocalHeadService } from './local-head-service.js';
import {
  attachSource,
  clearObservedHead,
  dropMissingBindings,
  ensureAttached,
  recordObservedHead,
} from './revision-publication/attach-state.js';
import {
  logHeadDecision,
  syncHead,
  updateSyncedState,
} from './revision-publication/head-sync.js';
import { listBindingSubscriptions } from './revision-publication/realtime-bindings.js';
import type {
  ActiveAttachState,
  BindingRealtimeState,
} from './revision-publication/types.js';
import type { ProjectRegistryService } from './project-registry-service.js';

export type { BindingRealtimeState } from './revision-publication/types.js';

export interface RevisionPublicationServiceOptions {
  backend: AgentBackendClient;
  projectRegistry: ProjectRegistryService;
  deviceId: string;
  deviceName: string;
  logger?: AgentLogger;
}

export class RevisionPublicationService {
  private readonly backend: AgentBackendClient;
  private readonly projectRegistry: ProjectRegistryService;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly logger: AgentLogger;
  private readonly localHeadService: LocalHeadService;
  private readonly stateByBindingId = new Map<number, ActiveAttachState>();

  constructor(options: RevisionPublicationServiceOptions) {
    this.backend = options.backend;
    this.projectRegistry = options.projectRegistry;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.logger = options.logger ?? noopAgentLogger;
    this.localHeadService = new LocalHeadService();
  }

  async ensureAttachedAndSyncHead(bindingId: number): Promise<void> {
    const project = await this.projectRegistry.requireProject(bindingId);
    this.logger.trace(
      'publish',
      `start bindingId=${bindingId} workspace=${project.workspacePath}`,
    );
    const observedHead = await this.localHeadService.readObservedHead(
      project.workspacePath,
    );
    if (!observedHead) {
      clearObservedHead(this.stateByBindingId, bindingId);
      this.logger.trace(
        'publish',
        `detached-head bindingId=${bindingId} name=${project.displayName}`,
      );
      return;
    }

    this.logger.trace(
      'publish',
      `candidate bindingId=${bindingId} branch=${observedHead.branch} commit=${observedHead.headCommitSha} remote=${observedHead.remoteFingerprint}`,
    );

    const state = recordObservedHead(
      this.stateByBindingId,
      bindingId,
      await ensureAttached({
        stateByBindingId: this.stateByBindingId,
        backend: this.backend,
        bindingId,
        observedHead,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        logger: this.logger,
      }),
      observedHead,
    );

    if (
      state.lastMaterializedHead &&
      state.lastMaterializedHead.attachEpoch === state.attachEpoch &&
      state.lastMaterializedHead.branch === observedHead.branch &&
      state.lastMaterializedHead.headCommitSha === observedHead.headCommitSha
    ) {
      this.logger.trace(
        'publish',
        `noop-dedup bindingId=${bindingId} attachEpoch=${state.attachEpoch} branch=${observedHead.branch} commit=${observedHead.headCommitSha}`,
      );
      return;
    }

    const previousQueuedHead = state.lastQueuedHead;
    let activeState = state;
    let syncedHead = await syncHead({
      backend: this.backend,
      bindingId,
      state: activeState,
      observedHead,
      deviceId: this.deviceId,
      logger: this.logger,
    });
    logHeadDecision({
      stateByBindingId: this.stateByBindingId,
      logger: this.logger,
      projectName: project.displayName,
      bindingId,
      observedHead,
      response: syncedHead,
      previousQueuedHead,
    });

    if (syncedHead.decision === 'stale_rejected') {
      this.logger.warn(
        'publish',
        `Head sync was rejected as stale for ${project.displayName} (#${bindingId}) on ${observedHead.branch}@${observedHead.headCommitSha.slice(0, 12)}; re-attaching source`,
      );

      activeState = recordObservedHead(
        this.stateByBindingId,
        bindingId,
        await attachSource({
          stateByBindingId: this.stateByBindingId,
          backend: this.backend,
          bindingId,
          observedHead,
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          logger: this.logger,
        }),
        observedHead,
      );
      syncedHead = await syncHead({
        backend: this.backend,
        bindingId,
        state: activeState,
        observedHead,
        deviceId: this.deviceId,
        logger: this.logger,
      });
      logHeadDecision({
        stateByBindingId: this.stateByBindingId,
        logger: this.logger,
        projectName: project.displayName,
        bindingId,
        observedHead,
        response: syncedHead,
        previousQueuedHead,
      });

      if (syncedHead.decision === 'stale_rejected') {
        throw new Error(
          `Stale head sync persists after re-attach for binding #${bindingId}`,
        );
      }
    }

    updateSyncedState(
      this.stateByBindingId,
      bindingId,
      activeState,
      syncedHead,
      observedHead,
    );
  }

  dropMissingBindings(activeBindingIds: Set<number>): void {
    dropMissingBindings(this.stateByBindingId, activeBindingIds);
  }

  listBindingSubscriptions(
    bindingIds: Iterable<number>,
  ): BindingRealtimeState[] {
    return listBindingSubscriptions(this.stateByBindingId, bindingIds);
  }

  getActiveAttachState(bindingId: number): ActiveAttachState | null {
    const state = this.stateByBindingId.get(bindingId);
    if (!state) {
      return null;
    }

    return {
      ...state,
      currentObservedHead: state.currentObservedHead
        ? { ...state.currentObservedHead }
        : undefined,
      lastMaterializedHead: state.lastMaterializedHead
        ? { ...state.lastMaterializedHead }
        : undefined,
      lastQueuedHead: state.lastQueuedHead
        ? { ...state.lastQueuedHead }
        : undefined,
    };
  }
}
