import { createHash } from 'node:crypto';
import type { AgentDb } from '../../db/schema.js';
import type { AgentRpcError, AgentRpcMethod } from './protocol.js';

interface AgentMetaRow {
  value: string;
}

interface StoredSuccessRecord<T> {
  kind: 'success';
  recordedAt: string;
  expiresAt?: string;
  requestFingerprint?: string;
  result: T;
}

interface StoredErrorRecord {
  kind: 'error';
  recordedAt: string;
  expiresAt?: string;
  requestFingerprint?: string;
  error: AgentRpcError;
}

export type StoredIdempotentRecord<T> =
  | StoredSuccessRecord<T>
  | StoredErrorRecord;

const IDEMPOTENCY_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class AgentRpcIdempotencyConflictError extends Error {
  constructor(method: AgentRpcMethod) {
    super(
      `idempotencyKey for ${method} was already used with different params`,
    );
    this.name = 'AgentRpcIdempotencyConflictError';
  }
}

export class AgentRpcIdempotencyStore {
  constructor(private readonly db: AgentDb) {}

  createRequestFingerprint(params: unknown): string {
    return createHash('sha256').update(stableStringify(params)).digest('hex');
  }

  async read<T>(
    method: AgentRpcMethod,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<StoredIdempotentRecord<T> | null> {
    const key = buildAgentMetaKey(method, idempotencyKey);
    const result = await this.db.query<AgentMetaRow>(
      'SELECT value FROM agent_meta WHERE key = $1 LIMIT 1',
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const record = JSON.parse(row.value) as StoredIdempotentRecord<T>;
    if (isExpired(record)) {
      await this.delete(key);
      return null;
    }
    if (
      record.requestFingerprint &&
      record.requestFingerprint !== requestFingerprint
    ) {
      throw new AgentRpcIdempotencyConflictError(method);
    }

    return record;
  }

  async writeSuccess<T>(
    method: AgentRpcMethod,
    idempotencyKey: string,
    requestFingerprint: string,
    result: T,
  ): Promise<void> {
    await this.write(method, idempotencyKey, {
      kind: 'success',
      recordedAt: new Date().toISOString(),
      expiresAt: toExpiryIsoString(),
      requestFingerprint,
      result,
    });
  }

  async writeError(
    method: AgentRpcMethod,
    idempotencyKey: string,
    requestFingerprint: string,
    error: AgentRpcError,
  ): Promise<void> {
    await this.write(method, idempotencyKey, {
      kind: 'error',
      recordedAt: new Date().toISOString(),
      expiresAt: toExpiryIsoString(),
      requestFingerprint,
      error,
    });
  }

  private async write<T>(
    method: AgentRpcMethod,
    idempotencyKey: string,
    value: StoredIdempotentRecord<T>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.query(
      `
      INSERT INTO agent_meta (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE
      SET value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [buildAgentMetaKey(method, idempotencyKey), JSON.stringify(value), now],
    );
  }

  private async delete(key: string): Promise<void> {
    await this.db.query('DELETE FROM agent_meta WHERE key = $1', [key]);
  }
}

function buildAgentMetaKey(
  method: AgentRpcMethod,
  idempotencyKey: string,
): string {
  return `rpc:idempotency:${method}:${Buffer.from(idempotencyKey, 'utf8').toString('base64url')}`;
}

function toExpiryIsoString(): string {
  return new Date(Date.now() + IDEMPOTENCY_RECORD_TTL_MS).toISOString();
}

function isExpired(record: StoredIdempotentRecord<unknown>): boolean {
  if (!record.expiresAt) {
    return false;
  }

  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
