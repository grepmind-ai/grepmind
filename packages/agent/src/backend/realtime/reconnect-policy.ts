export const DEFAULT_RECONNECT_BASE_MS = 1_000;

export function computeReconnectDelay(
  reconnectBaseMs: number,
  reconnectAttempts: number,
): number {
  return Math.min(reconnectBaseMs * Math.pow(2, reconnectAttempts), 30_000);
}
