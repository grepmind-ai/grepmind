import type { SearchTarget, SyncProjectRequest } from '../../backend/contracts/index.js';

export interface SyncCompleteness {
  filesSynced: boolean;
}

export interface RevisionProcessingState extends SyncCompleteness {
  needsFilesSync: boolean;
}

export interface LocalSyncSnapshot {
  requestLocalState: NonNullable<SyncProjectRequest['localState']>;
  payloadStateByRevisionId: Map<number, SyncCompleteness>;
  attachmentStateByAttachmentId: Map<number, SyncCompleteness>;
}

export interface SyncProjectOptions {
  targets?: SearchTarget[];
}

export interface SyncProjectResult {
  bindingId: number;
  revisionCount: number;
  materializedPlanCount: number;
  invalidationCount: number;
  syncedAt: string;
}
