import type {
  AgentCommitGraphErrorPayload,
  AgentCommitGraphRequestBase,
  AgentCommitGraphRequestPayload,
  AgentCommitGraphResponsePayload,
  AgentSnapshotArchiveLimits,
  AgentSnapshotExportBeginPayload,
  AgentSnapshotExportChunkPayload,
  AgentSnapshotExportEndPayload,
  AgentSnapshotExportErrorPayload,
  AgentSnapshotExportRequestPayload,
} from '../contracts/index.js';

type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function normalizeAgentSnapshotExportRequestPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentSnapshotExportRequestPayload> {
  const common = normalizeSourceRequestCommon(data);
  if (!common.ok) {
    return common;
  }

  const jobId = normalizeRequiredString(data?.jobId);
  if (!jobId) {
    return { ok: false, error: 'jobId is required' };
  }

  const targetCommitSha = normalizeCommitSha(data?.targetCommitSha);
  if (!targetCommitSha) {
    return {
      ok: false,
      error: 'targetCommitSha must be a full commit SHA',
    };
  }

  const archive = normalizeArchiveLimits(data?.archive);
  if (!archive.ok) {
    return archive;
  }

  return {
    ok: true,
    value: {
      ...common.value,
      jobId,
      targetCommitSha,
      archive: archive.value,
    },
  };
}

export function normalizeAgentCommitGraphRequestPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentCommitGraphRequestPayload> {
  const common = normalizeSourceRequestCommon(data);
  if (!common.ok) {
    return common;
  }

  if (data?.kind === 'nearest_attached_ancestor') {
    const targetSha = normalizeCommitSha(data.targetSha);
    if (!targetSha) {
      return { ok: false, error: 'targetSha must be a full commit SHA' };
    }
    if (!Array.isArray(data.attachedShas)) {
      return { ok: false, error: 'attachedShas must be an array' };
    }

    const attachedShas: string[] = [];
    for (const value of data.attachedShas) {
      const commitSha = normalizeCommitSha(value);
      if (!commitSha) {
        return {
          ok: false,
          error: 'attachedShas must contain full commit SHAs',
        };
      }
      attachedShas.push(commitSha);
    }

    const maxDepth = normalizePositiveInteger(data.maxDepth);
    if (maxDepth == null) {
      return { ok: false, error: 'maxDepth must be a positive integer' };
    }

    return {
      ok: true,
      value: {
        ...common.value,
        kind: 'nearest_attached_ancestor',
        targetSha,
        attachedShas,
        maxDepth,
      },
    };
  }

  if (data?.kind === 'first_parent_range') {
    const fromExclusiveSha = normalizeCommitSha(data.fromExclusiveSha);
    const toInclusiveSha = normalizeCommitSha(data.toInclusiveSha);
    if (!fromExclusiveSha || !toInclusiveSha) {
      return {
        ok: false,
        error: 'fromExclusiveSha and toInclusiveSha must be full commit SHAs',
      };
    }

    const maxCommits = normalizePositiveInteger(data.maxCommits);
    if (maxCommits == null) {
      return { ok: false, error: 'maxCommits must be a positive integer' };
    }

    return {
      ok: true,
      value: {
        ...common.value,
        kind: 'first_parent_range',
        fromExclusiveSha,
        toInclusiveSha,
        maxCommits,
      },
    };
  }

  return { ok: false, error: 'kind is invalid' };
}

export function normalizeSnapshotExportBeginPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentSnapshotExportBeginPayload> {
  const requestId = normalizeRequiredString(data?.requestId);
  const commitSha = normalizeCommitSha(data?.commitSha);
  const chunkBytes = normalizePositiveInteger(data?.chunkBytes);
  if (
    !requestId ||
    data?.format !== 'zip' ||
    !commitSha ||
    chunkBytes == null
  ) {
    return {
      ok: false,
      error: 'snapshot.export.begin payload is invalid',
    };
  }

  return {
    ok: true,
    value: { requestId, format: 'zip', commitSha, chunkBytes },
  };
}

export function normalizeSnapshotExportChunkPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentSnapshotExportChunkPayload> {
  const requestId = normalizeRequiredString(data?.requestId);
  const sequence = normalizeNonNegativeInteger(data?.sequence);
  const base64 = normalizeRequiredString(data?.base64);
  if (!requestId || sequence == null || !base64) {
    return {
      ok: false,
      error: 'snapshot.export.chunk payload is invalid',
    };
  }

  return { ok: true, value: { requestId, sequence, base64 } };
}

export function normalizeSnapshotExportEndPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentSnapshotExportEndPayload> {
  const requestId = normalizeRequiredString(data?.requestId);
  const totalBytes = normalizeNonNegativeInteger(data?.totalBytes);
  const sha256 = normalizeSha256(data?.sha256);
  if (!requestId || totalBytes == null || !sha256) {
    return { ok: false, error: 'snapshot.export.end payload is invalid' };
  }

  return { ok: true, value: { requestId, totalBytes, sha256 } };
}

export function normalizeSnapshotExportErrorPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentSnapshotExportErrorPayload> {
  const requestId = normalizeRequiredString(data?.requestId);
  const code = normalizeRequiredString(data?.code);
  const message = normalizeRequiredString(data?.message);
  const retryable =
    typeof data?.retryable === 'boolean' ? data.retryable : null;
  if (!requestId || !code || !message || retryable == null) {
    return { ok: false, error: 'snapshot.export.error payload is invalid' };
  }

  return { ok: true, value: { requestId, code, message, retryable } };
}

export function normalizeCommitGraphResponsePayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentCommitGraphResponsePayload> {
  const requestId = normalizeRequiredString(data?.requestId);
  if (!requestId) {
    return { ok: false, error: 'requestId is required' };
  }

  if (data?.kind === 'nearest_attached_ancestor') {
    const ancestorSha =
      data.ancestorSha == null ? null : normalizeCommitSha(data.ancestorSha);
    if (data.ancestorSha != null && !ancestorSha) {
      return { ok: false, error: 'ancestorSha must be a full commit SHA' };
    }

    return {
      ok: true,
      value: { requestId, kind: 'nearest_attached_ancestor', ancestorSha },
    };
  }

  if (data?.kind === 'first_parent_range') {
    if (!Array.isArray(data.commits)) {
      return { ok: false, error: 'commits must be an array' };
    }
    const commits: string[] = [];
    for (const value of data.commits) {
      const commitSha = normalizeCommitSha(value);
      if (!commitSha) {
        return { ok: false, error: 'commits must contain full commit SHAs' };
      }
      commits.push(commitSha);
    }

    return {
      ok: true,
      value: { requestId, kind: 'first_parent_range', commits },
    };
  }

  return { ok: false, error: 'kind is invalid' };
}

export function normalizeCommitGraphErrorPayload(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentCommitGraphErrorPayload> {
  const requestId = normalizeRequiredString(data?.requestId);
  const code = normalizeRequiredString(data?.code);
  const message = normalizeRequiredString(data?.message);
  const retryable =
    typeof data?.retryable === 'boolean' ? data.retryable : null;
  if (!requestId || !code || !message || retryable == null) {
    return { ok: false, error: 'commit_graph.error payload is invalid' };
  }

  return { ok: true, value: { requestId, code, message, retryable } };
}

export function extractRealtimeRequestId(
  data: Record<string, unknown> | undefined,
): string | null {
  return normalizeRequiredString(data?.requestId) || null;
}

function normalizeSourceRequestCommon(
  data: Record<string, unknown> | undefined,
): NormalizeResult<AgentCommitGraphRequestBase> {
  const requestId = normalizeRequiredString(data?.requestId);
  if (!requestId) {
    return { ok: false, error: 'requestId is required' };
  }

  const bindingId = normalizePositiveInteger(data?.bindingId);
  const repoId = normalizePositiveInteger(data?.repoId);
  const repoBranchId = normalizePositiveInteger(data?.repoBranchId);
  const expectedAttachEpoch = normalizePositiveInteger(
    data?.expectedAttachEpoch,
  );
  const expectedDeviceId = normalizeRequiredString(data?.expectedDeviceId);
  const expectedBranch = normalizeOptionalString(data?.expectedBranch);
  if (
    bindingId == null ||
    repoId == null ||
    repoBranchId == null ||
    expectedAttachEpoch == null ||
    !expectedDeviceId
  ) {
    return {
      ok: false,
      error:
        'bindingId, repoId, repoBranchId, expectedAttachEpoch, and expectedDeviceId are required',
    };
  }
  if (expectedBranch === null) {
    return { ok: false, error: 'expectedBranch must be a non-empty string' };
  }

  return {
    ok: true,
    value: {
      requestId,
      bindingId,
      repoId,
      repoBranchId,
      expectedAttachEpoch,
      expectedDeviceId,
      expectedBranch,
    },
  };
}

function normalizeArchiveLimits(
  value: unknown,
): NormalizeResult<AgentSnapshotArchiveLimits> {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'archive is required' };
  }

  const record = value as Record<string, unknown>;
  const maxBytes = normalizePositiveInteger(record.maxBytes);
  const maxFiles = normalizePositiveInteger(record.maxFiles);
  const maxExtractedBytes = normalizePositiveInteger(record.maxExtractedBytes);
  const chunkBytes = normalizePositiveInteger(record.chunkBytes);
  if (
    record.format !== 'zip' ||
    maxBytes == null ||
    maxFiles == null ||
    maxExtractedBytes == null ||
    chunkBytes == null
  ) {
    return {
      ok: false,
      error:
        'archive.format, maxBytes, maxFiles, maxExtractedBytes, and chunkBytes are required',
    };
  }

  return {
    ok: true,
    value: {
      format: 'zip',
      maxBytes,
      maxFiles,
      maxExtractedBytes,
      chunkBytes,
    },
  };
}

function normalizeCommitSha(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(normalized) ? normalized : null;
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value == null) {
    return undefined;
  }

  return normalizeRequiredString(value);
}

function normalizePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
