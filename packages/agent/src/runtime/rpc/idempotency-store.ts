import type { AgentDb } from '../../db/schema.js';
import type { AgentRpcError, AgentRpcMethod } from './protocol.js';

interface AgentMetaRow {
  value: string;
}

interface StoredSuccessRecord<T> {
  kind: 'success';
  recordedAt: string;
  result: T;
}

interface StoredErrorRecord {
  kind: 'error';
  recordedAt: string;
  error: AgentRpcError;
}

export type StoredIdempotentRecord<T> =
  | StoredSuccessRecord<T>
  | StoredErrorRecord;

export class AgentRpcIdempotencyStore {
  constructor(private readonly db: AgentDb) {}

  async read<T>(
    method: AgentRpcMethod,
    idempotencyKey: string,
  ): Promise<StoredIdempotentRecord<T> | null> {
    const result = await this.db.query<AgentMetaRow>(
      'SELECT value FROM agent_meta WHERE key = $1 LIMIT 1',
      [buildAgentMetaKey(method, idempotencyKey)],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return JSON.parse(row.value) as StoredIdempotentRecord<T>;
  }

  async writeSuccess<T>(
    method: AgentRpcMethod,
    idempotencyKey: string,
    result: T,
  ): Promise<void> {
    await this.write(method, idempotencyKey, {
      kind: 'success',
      recordedAt: new Date().toISOString(),
      result,
    });
  }

  async writeError(
    method: AgentRpcMethod,
    idempotencyKey: string,
    error: AgentRpcError,
  ): Promise<void> {
    await this.write(method, idempotencyKey, {
      kind: 'error',
      recordedAt: new Date().toISOString(),
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
}

function buildAgentMetaKey(
  method: AgentRpcMethod,
  idempotencyKey: string,
): string {
  return `rpc:idempotency:${method}:${Buffer.from(idempotencyKey, 'utf8').toString('base64url')}`;
}
