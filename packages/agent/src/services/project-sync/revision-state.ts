import type {
  InvalidationHint,
  MaterializationPlan,
  RevisionDelta,
  SearchTarget,
} from '../../backend/contracts/index.js';
import type { LocalSyncSnapshot } from './types.js';

export function buildInvalidationKey(invalidation: InvalidationHint): string {
  return [
    invalidation.kind,
    String(invalidation.revisionId ?? 'null'),
    invalidation.target,
    invalidation.reason,
  ].join(':');
}

export function buildMaterializationPlanKey(plan: MaterializationPlan): string {
  return [
    String(plan.revisionId),
    plan.target,
    String(plan.replaceRevisionId ?? 'null'),
    String(plan.desiredProfileVersion),
  ].join(':');
}

export function shouldCountRevisionWork(
  localState: LocalSyncSnapshot,
  revision: RevisionDelta,
): boolean {
  if (revision.needsFilesSync) {
    return true;
  }

  const payloadState = localState.payloadStateByRevisionId.get(
    revision.revisionId,
  );
  if (!payloadState) {
    return true;
  }

  return !payloadState.filesSynced;
}

export function uniqueTargets(targets: SearchTarget[]): SearchTarget[] {
  return [...new Set(targets)];
}
