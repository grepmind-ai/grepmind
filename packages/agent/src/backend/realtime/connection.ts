import type { WebSocketConstructor } from './types.js';

export const RealtimeWebSocket = (
  globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }
).WebSocket;

export const SOCKET_OPEN_STATE = 1;

export function buildRealtimeUrl(baseUrl: string, accessToken?: string, apiKey?: string): string {
  const url = new URL('/api/agent/v1/events', `${baseUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (accessToken) {
    url.searchParams.set('token', accessToken);
  }
  if (apiKey) {
    url.searchParams.set('apiKey', apiKey);
  }
  return url.toString();
}

export function parseMessageData(rawData: unknown): string | null {
  if (typeof rawData === 'string') {
    return rawData;
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString('utf8');
  }

  if (ArrayBuffer.isView(rawData)) {
    return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString('utf8');
  }

  return null;
}
