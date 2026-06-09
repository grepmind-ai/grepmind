import { randomBytes } from 'node:crypto';
import http from 'node:http';

import type { AgentConsole } from '../agent-console.js';
import type { StoredAgentAccountSession } from '../credential-store.js';

const ACCOUNT_SESSION_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface AccountSessionCallbackResult {
  accountSessionToken?: string;
  expiresAt?: string;
  refreshAfter?: string;
  account?: {
    accountId?: unknown;
    displayName?: unknown;
    clerkOrgSlug?: unknown;
  };
  handoffNonce?: string;
}

interface AccountSessionCallbackServer {
  port: number;
  origin: string;
  waitForCallback(): Promise<AccountSessionCallbackResult>;
  close(): Promise<void>;
}

export async function issueAgentAccountSessionWithBrowser(input: {
  apiBaseUrl: string;
  deviceId: string;
  noOpen: boolean;
  agentConsole: AgentConsole;
  openBrowser(url: string): Promise<void>;
  withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
}): Promise<StoredAgentAccountSession> {
  const handoffNonce = randomBase64Url(32);
  const callbackServer = await startAccountSessionCallbackServer({
    handoffNonce,
  });
  const handoffUrl = buildAccountSessionHandoffUrl({
    apiBaseUrl: input.apiBaseUrl,
    deviceId: input.deviceId,
    handoffNonce,
    localCallbackOrigin: callbackServer.origin,
  });

  if (input.noOpen) {
    input.agentConsole.info(
      'config',
      `Open this URL to select a Grepmind account: ${handoffUrl}`,
    );
  } else {
    input.agentConsole.info(
      'config',
      `Opening browser to select a Grepmind account: ${redactAccountSessionHandoffUrl(handoffUrl)}`,
    );
  }
  if (!input.noOpen) {
    try {
      await input.openBrowser(handoffUrl);
    } catch (error) {
      input.agentConsole.warn(
        'config',
        `AUTH_BROWSER_OPEN_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    const callback = await input.withTimeout(
      callbackServer.waitForCallback(),
      ACCOUNT_SESSION_CALLBACK_TIMEOUT_MS,
      'AGENT_ACCOUNT_SESSION_TIMEOUT: timed out waiting for account selection callback',
    );
    if (callback.handoffNonce !== handoffNonce) {
      throw new Error(
        'AGENT_ACCOUNT_SESSION_NONCE_MISMATCH: account session callback nonce did not match',
      );
    }
    return normalizeAccountSessionCallback(callback, input.deviceId);
  } finally {
    await callbackServer.close();
  }
}

function startAccountSessionCallbackServer(input: {
  handoffNonce: string;
}): Promise<AccountSessionCallbackServer> {
  let settled = false;
  let resolveCallback: (value: AccountSessionCallbackResult) => void = () => {};
  const callbackPromise = new Promise<AccountSessionCallbackResult>(
    (resolve) => {
      resolveCallback = resolve;
    },
  );
  const server = http.createServer((request, response) => {
    const origin = request.headers.origin;
    const corsOrigin = typeof origin === 'string' ? origin : '*';
    response.setHeader('Access-Control-Allow-Origin', corsOrigin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (
      request.method !== 'POST' ||
      url.pathname !== '/account-session/callback'
    ) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (settled) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Account session callback already received.');
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024) {
        request.destroy(
          new Error('Account session callback body is too large'),
        );
      }
    });
    request.on('end', () => {
      try {
        const callback = JSON.parse(body) as AccountSessionCallbackResult;
        if (
          !callback ||
          typeof callback !== 'object' ||
          Array.isArray(callback)
        ) {
          throw new Error('Invalid JSON');
        }
        if (callback.handoffNonce !== input.handoffNonce) {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Invalid handoff nonce' }));
          return;
        }
        settled = true;
        resolveCallback(callback);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  });

  return new Promise<AccountSessionCallbackServer>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      if (!port) {
        reject(new Error('Failed to resolve account session callback port'));
        return;
      }
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        waitForCallback: () => callbackPromise,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function buildAccountSessionHandoffUrl(input: {
  apiBaseUrl: string;
  deviceId: string;
  handoffNonce: string;
  localCallbackOrigin: string;
}): string {
  const url = new URL('/agent/account-session', input.apiBaseUrl);
  url.searchParams.set('deviceId', input.deviceId);
  url.searchParams.set('localCallbackOrigin', input.localCallbackOrigin);
  const fragment = new URLSearchParams();
  fragment.set('handoffNonce', input.handoffNonce);
  url.hash = fragment.toString();
  return url.toString();
}

function redactAccountSessionHandoffUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('handoffNonce')) {
      url.searchParams.set('handoffNonce', 'redacted');
    }
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (fragment.has('handoffNonce')) {
      fragment.set('handoffNonce', 'redacted');
      url.hash = fragment.toString();
    }
    return url.toString();
  } catch {
    return value.replaceAll(/([?#&]handoffNonce=)[^&]+/g, '$1redacted');
  }
}

function normalizeAccountSessionCallback(
  callback: AccountSessionCallbackResult,
  deviceId: string,
): StoredAgentAccountSession {
  if (
    typeof callback.accountSessionToken !== 'string' ||
    typeof callback.expiresAt !== 'string' ||
    typeof callback.refreshAfter !== 'string' ||
    !callback.account ||
    typeof callback.account.accountId !== 'number' ||
    typeof callback.account.displayName !== 'string'
  ) {
    throw new Error(
      'AGENT_ACCOUNT_SESSION_INVALID: account session callback payload is invalid',
    );
  }

  return {
    token: callback.accountSessionToken,
    deviceId,
    expiresAt: callback.expiresAt,
    refreshAfter: callback.refreshAfter,
    account: {
      accountId: callback.account.accountId,
      displayName: callback.account.displayName,
      clerkOrgSlug:
        typeof callback.account.clerkOrgSlug === 'string'
          ? callback.account.clerkOrgSlug
          : null,
    },
  };
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}
