import { randomUUID } from 'node:crypto';
import { createAgentConsole } from '../cli-context.js';
import {
  executeSocketPreferredCommand,
  isIdleSyncResult,
} from '../command-support.js';
import { getIntegerFlag } from '../flags.js';
import type { ParsedArgs } from '../parse-args.js';

export async function syncCommand(args: ParsedArgs): Promise<void> {
  const agentConsole = createAgentConsole(args);
  const bindingId = getIntegerFlag(args, 'binding-id');
  const requestId = randomUUID();
  const result = await executeSocketPreferredCommand(args, {
    rpc: (client) => client.request('syncProject', {
      bindingId,
      idempotencyKey: requestId,
    }),
  });

  if (bindingId != null) {
    const singleResult = result.results[0];
    if (isIdleSyncResult(singleResult)) {
      agentConsole.info(
        'sync',
        `No new sync deltas for binding #${bindingId}`,
      );
    } else {
      agentConsole.success(
        'sync',
        `Synced binding #${bindingId}: revisions=${singleResult.revisionCount}, materializations=${singleResult.materializedPlanCount}, invalidations=${singleResult.invalidationCount}`,
      );
    }
    return;
  }

  if (result.results.length === 0) {
    agentConsole.info('project', 'No registered projects');
    return;
  }

  for (const item of result.results) {
    if (isIdleSyncResult(item)) {
      agentConsole.info(
        'sync',
        `No new sync deltas for binding #${item.bindingId}`,
      );
    } else {
      agentConsole.success(
        'sync',
        `Synced binding #${item.bindingId}: revisions=${item.revisionCount}, materializations=${item.materializedPlanCount}, invalidations=${item.invalidationCount}`,
      );
    }
  }
}
