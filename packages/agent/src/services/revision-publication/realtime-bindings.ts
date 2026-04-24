import type { ActiveAttachState, BindingRealtimeState } from './types.js';

export function listBindingSubscriptions(
  stateByBindingId: Map<number, ActiveAttachState>,
  bindingIds: Iterable<number>,
): BindingRealtimeState[] {
  const items: BindingRealtimeState[] = [];
  for (const bindingId of bindingIds) {
    const state = stateByBindingId.get(bindingId);
    const item: BindingRealtimeState = {
      bindingId,
      attachEpoch: state?.attachEpoch,
    };
    if (state?.currentObservedHead) {
      item.branch = state.currentObservedHead.branch;
      item.headCommitSha = state.currentObservedHead.headCommitSha;
      item.observedAt = state.currentObservedHead.observedAt;
    }
    items.push(item);
  }

  return items;
}
