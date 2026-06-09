import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { WebSocketConstructor } from './types.js';

export const RealtimeWebSocket = (
  globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }
).WebSocket;

export const SOCKET_OPEN_STATE = 1;
const SOCKET_CLOSING_STATE = 2;
const SOCKET_CLOSED_STATE = 3;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function buildRealtimeUrl(baseUrl: string): string {
  const url = new URL('/api/agent/v1/events', `${baseUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function createRealtimeWebSocket(
  url: string,
  headers: Record<string, string>,
) {
  return new NodeHeaderWebSocket(url, headers);
}

export function parseMessageData(rawData: unknown): string | null {
  if (typeof rawData === 'string') {
    return rawData;
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString('utf8');
  }

  if (ArrayBuffer.isView(rawData)) {
    return Buffer.from(
      rawData.buffer,
      rawData.byteOffset,
      rawData.byteLength,
    ).toString('utf8');
  }

  return null;
}

class NodeHeaderWebSocket {
  readyState = 0;
  onopen: ((...args: any[]) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((...args: any[]) => void) | null = null;
  private socket: Duplex | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {
    this.connect();
  }

  send(data: string): void {
    if (this.readyState !== SOCKET_OPEN_STATE || !this.socket) {
      return;
    }
    this.socket.write(encodeFrame(Buffer.from(data, 'utf8'), 0x1));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === SOCKET_CLOSED_STATE || this.closed) {
      return;
    }
    this.readyState = SOCKET_CLOSING_STATE;
    const reasonBuffer = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket?.write(encodeFrame(payload, 0x8));
    this.socket?.end();
    this.finishClose(code, reason);
  }

  private connect(): void {
    const parsed = new URL(this.url);
    const isSecure = parsed.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    const request = (isSecure ? https : http).request({
      protocol: isSecure ? 'https:' : 'http:',
      hostname: parsed.hostname,
      port: parsed.port || (isSecure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        ...this.headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    request.once('upgrade', (response, socket) => {
      const accept = response.headers['sec-websocket-accept'];
      if (typeof accept !== 'string' || accept !== createAcceptHeader(key)) {
        socket.destroy();
        this.fail(new Error('Realtime websocket handshake was rejected'));
        return;
      }

      this.socket = socket;
      this.readyState = SOCKET_OPEN_STATE;
      socket.on('data', (chunk) => this.handleData(chunk));
      socket.on('close', () => this.finishClose());
      socket.on('error', (error) => this.fail(error));
      this.onopen?.();
    });

    request.once('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        this.fail(
          new Error(
            `Realtime websocket handshake failed with HTTP ${response.statusCode}: ${body}`,
          ),
        );
      });
    });
    request.once('error', (error) => this.fail(error));
    request.end();
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const parsed = decodeFrame(this.buffer);
      if (!parsed) {
        return;
      }
      this.buffer = this.buffer.subarray(parsed.consumed);

      if (parsed.opcode === 0x1) {
        this.onmessage?.({ data: parsed.payload.toString('utf8') });
        continue;
      }
      if (parsed.opcode === 0x8) {
        const code =
          parsed.payload.length >= 2 ? parsed.payload.readUInt16BE(0) : 1000;
        const reason =
          parsed.payload.length > 2
            ? parsed.payload.subarray(2).toString('utf8')
            : '';
        this.socket?.end();
        this.finishClose(code, reason);
        return;
      }
      if (parsed.opcode === 0x9) {
        this.socket?.write(encodeFrame(parsed.payload, 0xa));
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.onerror?.(error);
    this.finishClose(1006, error.message);
  }

  private finishClose(code = 1000, reason = ''): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = SOCKET_CLOSED_STATE;
    this.socket?.destroy();
    this.socket = null;
    this.onclose?.({ code, reason });
  }
}

function createAcceptHeader(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const payloadLength = payload.length;
  const lengthBytes = payloadLength < 126 ? 0 : payloadLength <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  if (payloadLength < 126) {
    header[1] = 0x80 | payloadLength;
  } else if (payloadLength <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  const maskOffset = 2 + lengthBytes;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(payloadLength);
  for (let index = 0; index < payloadLength; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }

  return Buffer.concat([header, masked]);
}

function decodeFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Realtime websocket frame is too large');
    }
    length = Number(bigLength);
    offset += 8;
  }

  const masked = (buffer[1] & 0x80) !== 0;
  const maskOffset = offset;
  if (masked) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    consumed: offset + length,
  };
}
