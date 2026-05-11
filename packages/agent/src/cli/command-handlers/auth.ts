import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentAuthClient } from '../../backend/agent-auth-client.js';
import {
  AgentBackendClient,
  AgentBackendClientError,
} from '../../backend/agent-backend-client.js';
import type {
  AgentAuthMetadataResponse,
  OAuthTokenResponse,
} from '../../backend/contracts/index.js';
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_HEAD_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  ensureDataDir,
  resolveDataDir,
  saveAgentCliConfig,
  type AgentCliConfig,
} from '../config.js';
import {
  buildCredentialStoreKey,
  createCredentialStore,
  type StoredOAuthCredential,
} from '../credential-store.js';
import { createAgentConsole } from '../cli-context.js';
import {
  getIntegerFlag,
  getOptionalIntegerFlagStrict,
  getStringFlag,
  hasBooleanFlag,
  nonEmptyString,
  toInteger,
} from '../flags.js';
import { loadOptionalConfig } from '../command-support.js';
import type { ParsedArgs } from '../parse-args.js';

const DEFAULT_SCOPES = ['profile', 'email'] as const;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCallback(): Promise<CallbackResult>;
  close(): Promise<void>;
}

export async function authCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.positionals[0] ?? 'status';
  switch (subcommand) {
    case 'login':
      await authLoginCommand(args);
      return;
    case 'status':
      await authStatusCommand(args);
      return;
    case 'logout':
      await authLogoutCommand(args);
      return;
    default:
      throw new Error(`Unknown command: auth ${subcommand}`);
  }
}

async function authLoginCommand(args: ParsedArgs): Promise<void> {
  validateAuthLoginArgs(args);

  const agentConsole = createAgentConsole(args);
  const dataDir = resolveDataDir(
    getStringFlag(args, 'data-dir') ?? process.env.GREPMIND_AGENT_DATA_DIR,
  );
  await ensureDataDir(dataDir);
  const existingConfig = await loadOptionalConfig(dataDir);
  const hostname = requireHostname(args);
  const apiBaseUrl = resolveApiBaseUrlFromHostname(hostname);
  const requestedScopes = parseScopes(getStringFlag(args, 'scopes'));
  const callbackPort = getOptionalIntegerFlagStrict(args, 'callback-port');
  const store = createCredentialStore();
  if (store.kind() === 'unsupported') {
    throw new Error(
      `AUTH_SECURE_STORAGE_UNAVAILABLE: secure credential storage is not implemented on ${process.platform}`,
    );
  }

  const authClient = new AgentAuthClient({ baseUrl: apiBaseUrl });
  const metadata = authClient.validateMetadata(
    await authClient.fetchAuthMetadata(),
    requestedScopes,
  );
  const callbackServer = await startCallbackServer(metadata, callbackPort);
  const state = randomBase64Url(32);
  const nonce = requestedScopes.includes('openid')
    ? randomBase64Url(32)
    : undefined;
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  const authorizationUrl = buildAuthorizationUrl({
    metadata,
    redirectUri: callbackServer.redirectUri,
    scopes: requestedScopes,
    state,
    nonce,
    codeChallenge,
  });

  agentConsole.info(
    'config',
    `Open this URL to authorize Grepmind CLI: ${authorizationUrl}`,
  );
  if (!hasBooleanFlag(args, 'no-open')) {
    try {
      await openBrowser(authorizationUrl);
    } catch (error) {
      agentConsole.warn(
        'config',
        `AUTH_BROWSER_OPEN_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    const callback = await withTimeout(
      callbackServer.waitForCallback(),
      CALLBACK_TIMEOUT_MS,
      'AUTH_CALLBACK_TIMEOUT: timed out waiting for browser authorization callback',
    );
    if (callback.error) {
      throw new Error(
        `AUTHORIZATION_DENIED: ${callback.errorDescription ?? callback.error}`,
      );
    }
    if (!callback.code) {
      throw new Error(
        'AUTH_CALLBACK_INVALID: callback did not include an authorization code',
      );
    }
    if (callback.state !== state) {
      throw new Error(
        'AUTH_STATE_MISMATCH: authorization callback state did not match',
      );
    }

    const tokenResponse = await authClient.exchangeAuthorizationCode({
      tokenEndpoint: metadata.tokenEndpoint,
      clientId: metadata.clientId,
      code: callback.code,
      redirectUri: callbackServer.redirectUri,
      codeVerifier,
    });
    validateTokenResponse(tokenResponse);
    const userInfo = metadata.userInfoEndpoint
      ? await authClient
          .fetchUserInfo(metadata.userInfoEndpoint, tokenResponse.access_token!)
          .catch((error) => {
            agentConsole.warn(
              'config',
              `AUTH_USERINFO_FAILED: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })
      : null;

    const accountSubject = nonEmptyString(userInfo?.sub) ?? null;
    const accountEmail = nonEmptyString(userInfo?.email) ?? null;
    const credentialStoreKey = buildCredentialStoreKey({
      host: hostname,
      accountSubject,
      nonce: randomUUID(),
    });
    const expiresAt = new Date(
      Date.now() + tokenResponse.expires_in! * 1000,
    ).toISOString();
    const credential: StoredOAuthCredential = {
      credentialType: 'oauth_token',
      host: hostname,
      apiBaseUrl,
      accessToken: tokenResponse.access_token!,
      refreshToken: tokenResponse.refresh_token!,
      tokenEndpoint: metadata.tokenEndpoint,
      ...(metadata.userInfoEndpoint
        ? { userInfoEndpoint: metadata.userInfoEndpoint }
        : {}),
      oauthClientId: metadata.clientId,
      scopes: requestedScopes,
      expiresAt,
      accountSubject,
      accountEmail,
    };
    const config: AgentCliConfig = {
      apiBaseUrl,
      name:
        getStringFlag(args, 'name') ??
        process.env.GREPMIND_AGENT_NAME ??
        existingConfig?.name ??
        DEFAULT_AGENT_NAME,
      pollIntervalMs:
        getIntegerFlag(args, 'poll-interval-ms') ??
        toInteger(process.env.GREPMIND_AGENT_POLL_INTERVAL_MS) ??
        existingConfig?.pollIntervalMs ??
        DEFAULT_POLL_INTERVAL_MS,
      headPollIntervalMs:
        getIntegerFlag(args, 'head-poll-interval-ms') ??
        toInteger(process.env.GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS) ??
        existingConfig?.headPollIntervalMs ??
        DEFAULT_HEAD_POLL_INTERVAL_MS,
      deviceId:
        nonEmptyString(
          getStringFlag(args, 'device-id') ??
            process.env.GREPMIND_AGENT_DEVICE_ID,
        ) ??
        existingConfig?.deviceId ??
        randomUUID(),
      dataDir,
      auth: {
        credentialType: 'oauth_token',
        host: hostname,
        accountSubject,
        accountEmail,
        expiresAt,
        credentialStoreKey,
        credentialStoreKind: store.kind(),
        oauthClientId: metadata.clientId,
      },
    };
    const bootstrapAccessToken = tokenResponse.access_token!;
    const bootstrapClient = new AgentBackendClient({
      baseUrl: apiBaseUrl,
      accessToken: () => bootstrapAccessToken,
      defaultHeaders: {
        'X-Grepmind-Agent-Name': config.name,
      },
      logger: agentConsole,
    });
    let bootstrap: Awaited<ReturnType<AgentBackendClient['bootstrap']>>;
    try {
      bootstrap = await bootstrapClient.bootstrap();
    } catch (error) {
      if (error instanceof AgentBackendClientError) {
        throw new TypeError(
          `${error.message} (status=${error.status}, code=${error.code}, OAuth client id from metadata: ${metadata.clientId})`,
        );
      }
      throw error;
    }

    await store.set(credentialStoreKey, credential);
    const configPath = await saveAgentCliConfig(config);

    agentConsole.success(
      'config',
      `Authenticated ${accountEmail ?? accountSubject ?? 'account'} for ${hostname}`,
    );
    agentConsole.info(
      'config',
      `Configured agent "${config.name}" at ${configPath} (api=${bootstrap.agentApiVersion}, server=${bootstrap.serverInstanceId})`,
    );
  } finally {
    await callbackServer.close();
  }
}

function validateAuthLoginArgs(args: ParsedArgs): void {
  rejectUnexpectedPositionals(args, 1);
  rejectUnknownFlags(args, [
    'hostname',
    'scopes',
    'no-open',
    'callback-port',
    'device',
    'data-dir',
    'name',
    'poll-interval-ms',
    'head-poll-interval-ms',
    'device-id',
    'trace',
  ]);
  if (args.flags.has('device')) {
    throw new Error(
      'AUTH_DEVICE_FLOW_UNSUPPORTED: device flow is not supported; use browser login on this machine',
    );
  }
}

async function authStatusCommand(args: ParsedArgs): Promise<void> {
  rejectUnexpectedPositionals(args, 1);
  rejectUnknownFlags(args, ['data-dir', 'trace']);
  const agentConsole = createAgentConsole(args);
  const dataDir = resolveDataDir(
    getStringFlag(args, 'data-dir') ?? process.env.GREPMIND_AGENT_DATA_DIR,
  );
  const config = await loadOptionalConfig(dataDir);
  if (!config?.auth) {
    agentConsole.info('config', `Not logged in for ${dataDir}`);
    return;
  }

  let storeStatus = 'unknown';
  try {
    const store = createCredentialStore();
    storeStatus = (await store.get(config.auth.credentialStoreKey))
      ? 'available'
      : 'missing';
  } catch {
    storeStatus = 'unavailable';
  }

  agentConsole.info('config', `Backend: ${config.apiBaseUrl}`);
  agentConsole.info('config', `Credential: ${config.auth.credentialType}`);
  agentConsole.info(
    'config',
    `Account: ${config.auth.accountEmail ?? config.auth.accountSubject ?? 'unknown'}`,
  );
  agentConsole.info('config', `Expires: ${config.auth.expiresAt}`);
  agentConsole.info('config', `Refresh: ${storeStatus}`);
  agentConsole.info('config', `Storage: ${config.auth.credentialStoreKind}`);
}

async function authLogoutCommand(args: ParsedArgs): Promise<void> {
  rejectUnexpectedPositionals(args, 1);
  rejectUnknownFlags(args, ['data-dir', 'trace']);
  const agentConsole = createAgentConsole(args);
  const dataDir = resolveDataDir(
    getStringFlag(args, 'data-dir') ?? process.env.GREPMIND_AGENT_DATA_DIR,
  );
  const config = await loadOptionalConfig(dataDir);
  if (!config?.auth) {
    agentConsole.info(
      'config',
      `No local Grepmind CLI OAuth credential found for ${dataDir}`,
    );
    return;
  }

  const store = createCredentialStore();
  await store.delete(config.auth.credentialStoreKey);
  const nextConfig: AgentCliConfig = { ...config };
  delete nextConfig.auth;
  await saveAgentCliConfig(nextConfig);
  agentConsole.info('config', 'Removed local Grepmind CLI OAuth credential');
}

function requireHostname(args: ParsedArgs): string {
  const hostname = getStringFlag(args, 'hostname')?.trim();
  if (!hostname) {
    throw new Error('--hostname is required');
  }
  return hostname;
}

function resolveApiBaseUrlFromHostname(hostname: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)) {
    throw new Error('--hostname must not include a scheme');
  }
  if (/[/?#]/.test(hostname)) {
    throw new Error('--hostname must not include a path, query, or fragment');
  }

  const lower = hostname.toLowerCase();
  const scheme =
    lower === 'localhost' ||
    lower.startsWith('localhost:') ||
    lower === '127.0.0.1' ||
    lower.startsWith('127.0.0.1:')
      ? 'http'
      : 'https';
  const url = new URL(`${scheme}://${hostname}`);
  return url.toString().replace(/\/$/, '');
}

function parseScopes(value: string | undefined): string[] {
  if (!value) {
    return [...DEFAULT_SCOPES];
  }
  const scopes = value
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    throw new Error('--scopes must include at least one scope');
  }
  return scopes;
}

async function startCallbackServer(
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

function buildAuthorizationUrl(input: {
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

function validateTokenResponse(response: OAuthTokenResponse): void {
  if (!response.access_token) {
    throw new Error(
      'AUTH_TOKEN_EXCHANGE_FAILED: token response did not include an access token',
    );
  }
  if (response.token_type?.toLowerCase() !== 'bearer') {
    throw new Error('AUTH_TOKEN_EXCHANGE_FAILED: token_type must be Bearer');
  }
  if (typeof response.expires_in !== 'number' || response.expires_in <= 0) {
    throw new Error(
      'AUTH_TOKEN_EXCHANGE_FAILED: token response did not include a valid expires_in',
    );
  }
  if (!response.refresh_token) {
    throw new Error(
      'AUTH_REFRESH_TOKEN_REQUIRED: token response did not include a refresh token',
    );
  }
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? '/usr/bin/open'
      : process.platform === 'win32'
        ? 'cmd.exe'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const timeout = delay(timeoutMs).then(() => {
    throw new Error(message);
  });
  return Promise.race([promise, timeout]);
}

function rejectUnexpectedPositionals(
  args: ParsedArgs,
  allowedCount: number,
): void {
  if (args.positionals.length > allowedCount) {
    throw new Error(`Unknown command: auth ${args.positionals.join(' ')}`);
  }
}

function rejectUnknownFlags(args: ParsedArgs, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const flag of args.flags.keys()) {
    if (!allowedSet.has(flag)) {
      throw new Error(`Unknown flag: --${flag}`);
    }
  }
}
