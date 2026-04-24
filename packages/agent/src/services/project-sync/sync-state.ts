import type { AgentDb } from '../../db/schema.js';

export async function markSyncStarted(
  db: AgentDb,
  bindingId: number,
  startedAt: string,
): Promise<void> {
  await db.query(
    `
    INSERT INTO project_binding_sync_state (
      binding_id,
      status,
      error_message,
      last_sync_started_at,
      last_sync_completed_at,
      updated_at
    )
    VALUES ($1, 'syncing', NULL, $2, NULL, $2)
    ON CONFLICT (binding_id) DO UPDATE
    SET status = 'syncing',
        error_message = NULL,
        last_sync_started_at = excluded.last_sync_started_at,
        updated_at = excluded.updated_at
    `,
    [bindingId, startedAt],
  );
}

export async function markSyncCompleted(
  db: AgentDb,
  bindingId: number,
  completedAt: string,
): Promise<void> {
  await db.query(
    `
    INSERT INTO project_binding_sync_state (
      binding_id,
      status,
      error_message,
      last_sync_started_at,
      last_sync_completed_at,
      updated_at
    )
    VALUES ($1, 'ready', NULL, NULL, $2, $2)
    ON CONFLICT (binding_id) DO UPDATE
    SET status = 'ready',
        error_message = NULL,
        last_sync_completed_at = excluded.last_sync_completed_at,
        updated_at = excluded.updated_at
    `,
    [bindingId, completedAt],
  );
  await db.query(
    `
    UPDATE projects
    SET last_synced_at = $2,
        updated_at = CASE
          WHEN updated_at < $2 THEN $2
          ELSE updated_at
        END
    WHERE binding_id = $1
    `,
    [bindingId, completedAt],
  );
}

export async function markSyncErrored(
  db: AgentDb,
  bindingId: number,
  message: string,
): Promise<void> {
  const failedAt = new Date().toISOString();
  await db.query(
    `
    INSERT INTO project_binding_sync_state (
      binding_id,
      status,
      error_message,
      last_sync_started_at,
      last_sync_completed_at,
      updated_at
    )
    VALUES ($1, 'error', $2, NULL, NULL, $3)
    ON CONFLICT (binding_id) DO UPDATE
    SET status = 'error',
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
    `,
    [bindingId, message, failedAt],
  );
}
