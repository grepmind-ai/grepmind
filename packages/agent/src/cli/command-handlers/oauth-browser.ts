import { createHash } from 'node:crypto';
import http from 'node:http';

import type { AgentAuthMetadataResponse } from '../../backend/contracts/index.js';

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCallback(): Promise<CallbackResult>;
  close(): Promise<void>;
}

export async function startCallbackServer(
  metadata: AgentAuthMetadataResponse,
  requestedPort: number | undefined,
): Promise<CallbackServer> {
  const candidatePorts =
    requestedPort == null ? metadata.callbackPorts : [requestedPort];
  if (
    requestedPort != null &&
    !metadata.callbackPorts.includes(requestedPort)
  ) {
    throw new Error(
      'AUTH_CALLBACK_PORT_UNAVAILABLE: --callback-port must be listed in auth metadata',
    );
  }

  const errors: string[] = [];
  for (const port of candidatePorts) {
    try {
      return await bindCallbackServer(metadata, port);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`AUTH_CALLBACK_PORT_UNAVAILABLE: ${errors.join('; ')}`);
}

export function buildAuthorizationUrl(input: {
  metadata: AgentAuthMetadataResponse;
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce?: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.metadata.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  if (input.nonce) {
    url.searchParams.set('nonce', input.nonce);
  }
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function buildCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function bindCallbackServer(
  metadata: AgentAuthMetadataResponse,
  port: number,
): Promise<CallbackServer> {
  let settled = false;
  let resolveCallback: (value: CallbackResult) => void = () => {};
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== metadata.callbackPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (settled) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authorization callback already received.');
      return;
    }
    settled = true;
    resolveCallback({
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      errorDescription: url.searchParams.get('error_description') ?? undefined,
    });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><title>Grepmind CLI</title><p>Grepmind CLI authorization complete. You can close this tab.</p>',
    );
  });

  return new Promise<CallbackServer>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}${metadata.callbackPath}`,
        waitForCallback: () => callbackPromise,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}
