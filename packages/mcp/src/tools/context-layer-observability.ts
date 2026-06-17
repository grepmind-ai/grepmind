import { createHash } from 'node:crypto';

export type ContextLayerCounter =
  | 'context_layer_requested'
  | 'context_layer_subagent_started'
  | 'context_layer_subagent_completed'
  | 'context_layer_subagent_failed'
  | 'context_layer_subagent_timeout'
  | 'context_layer_fanout_started'
  | 'context_layer_fanout_completed'
  | 'context_layer_file_summary_started'
  | 'context_layer_file_summary_completed'
  | 'context_layer_file_summary_failed'
  | 'context_layer_file_summary_timeout'
  | 'context_layer_aggregation_started'
  | 'context_layer_aggregation_completed'
  | 'context_layer_output_truncated'
  | 'context_layer_recursion_blocked'
  | 'context_layer_profile_missing'
  | 'context_layer_prompt_refiner_started'
  | 'context_layer_prompt_refiner_completed'
  | 'context_layer_prompt_refiner_failed'
  | 'context_layer_prompt_refiner_timeout'
  | 'context_layer_agent_questions_returned'
  | 'context_layer_refinement_session_created'
  | 'context_layer_refinement_session_resumed'
  | 'context_layer_refinement_session_expired'
  | 'context_layer_refinement_session_completed';

const counters = new Map<ContextLayerCounter, number>();

export function incrementContextLayerCounter(
  counter: ContextLayerCounter,
  details?: Record<string, string | number | boolean | undefined>,
): void {
  counters.set(counter, (counters.get(counter) ?? 0) + 1);

  if (process.env.GREPMIND_CONTEXT_LAYER_LOG !== '1') {
    return;
  }

  const safeDetails = Object.fromEntries(
    Object.entries(details ?? {}).filter(([, value]) => value !== undefined),
  );
  console.error(
    `[grepmind context_layer] ${counter} ${JSON.stringify(safeDetails)}`,
  );
}

export function hashWorkspacePath(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

export function hashRefinementSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

export function getContextLayerCounters(): Record<ContextLayerCounter, number> {
  return {
    context_layer_requested: counters.get('context_layer_requested') ?? 0,
    context_layer_subagent_started:
      counters.get('context_layer_subagent_started') ?? 0,
    context_layer_subagent_completed:
      counters.get('context_layer_subagent_completed') ?? 0,
    context_layer_subagent_failed:
      counters.get('context_layer_subagent_failed') ?? 0,
    context_layer_subagent_timeout:
      counters.get('context_layer_subagent_timeout') ?? 0,
    context_layer_fanout_started:
      counters.get('context_layer_fanout_started') ?? 0,
    context_layer_fanout_completed:
      counters.get('context_layer_fanout_completed') ?? 0,
    context_layer_file_summary_started:
      counters.get('context_layer_file_summary_started') ?? 0,
    context_layer_file_summary_completed:
      counters.get('context_layer_file_summary_completed') ?? 0,
    context_layer_file_summary_failed:
      counters.get('context_layer_file_summary_failed') ?? 0,
    context_layer_file_summary_timeout:
      counters.get('context_layer_file_summary_timeout') ?? 0,
    context_layer_aggregation_started:
      counters.get('context_layer_aggregation_started') ?? 0,
    context_layer_aggregation_completed:
      counters.get('context_layer_aggregation_completed') ?? 0,
    context_layer_output_truncated:
      counters.get('context_layer_output_truncated') ?? 0,
    context_layer_recursion_blocked:
      counters.get('context_layer_recursion_blocked') ?? 0,
    context_layer_profile_missing:
      counters.get('context_layer_profile_missing') ?? 0,
    context_layer_prompt_refiner_started:
      counters.get('context_layer_prompt_refiner_started') ?? 0,
    context_layer_prompt_refiner_completed:
      counters.get('context_layer_prompt_refiner_completed') ?? 0,
    context_layer_prompt_refiner_failed:
      counters.get('context_layer_prompt_refiner_failed') ?? 0,
    context_layer_prompt_refiner_timeout:
      counters.get('context_layer_prompt_refiner_timeout') ?? 0,
    context_layer_agent_questions_returned:
      counters.get('context_layer_agent_questions_returned') ?? 0,
    context_layer_refinement_session_created:
      counters.get('context_layer_refinement_session_created') ?? 0,
    context_layer_refinement_session_resumed:
      counters.get('context_layer_refinement_session_resumed') ?? 0,
    context_layer_refinement_session_expired:
      counters.get('context_layer_refinement_session_expired') ?? 0,
    context_layer_refinement_session_completed:
      counters.get('context_layer_refinement_session_completed') ?? 0,
  };
}
