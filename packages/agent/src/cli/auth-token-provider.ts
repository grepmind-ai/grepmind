import { AgentAuthClient } from '../backend/agent-auth-client.js';
import {
  AGENT_ACCOUNT_SESSION_CAPABILITY,
  AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER,
  AGENT_ACCOUNT_SESSION_DEVICE_HEADER,
  AGENT_ACCOUNT_SESSION_HEADER,
  type AgentAccountSessionResponse,
  type AgentBackendAccountSessionProvider,
} from '../backend/account-session.js';
import type { AgentBackendAccessTokenProvider } from '../backend/agent-backend-client.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import type { AgentCliConfig } from './config.js';
import { saveAgentCliConfig } from './config.js';
import {
  createCredentialStore,
  type StoredOAuthCredential,
} from './credential-store.js';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const ACCOUNT_SESSION_REFRESH_SKEW_MS = 30_000;

export function createAuthAccessTokenProvider(
  config: AgentCliConfig,
  logger?: AgentLogger,
): AgentBackendAccessTokenProvider {
  const listeners = new Set<(token: string) => void>();
  const notifyRefresh = (token: string) => {
    for (const listener of listeners) {
      listener(token);
    }
  };
  const provider = (async () =>
    getAccessToken(
      config,
      logger,
      notifyRefresh,
    )) as AgentBackendAccessTokenProvider;
  provider.refresh = () => refreshAccessToken(config, logger, notifyRefresh);
  provider.onRefresh = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return provider;
}

export function createAccountSessionProvider(
  config: AgentCliConfig,
  accessTokenProvider: AgentBackendAccessTokenProvider,
  logger?: AgentLogger,
): AgentBackendAccountSessionProvider | undefined {
  if (!config.auth) {
    return undefined;
  }

  const provider = (async () => {
    const credential = await loadCredential(config);
    const session = normalizeAccountSessionCredential(
      credential.accountSession,
      config.deviceId,
    );
    if (!session?.token) {
      return { deviceId: config.deviceId };
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    if (
      Number.isFinite(expiresAtMs) &&
      expiresAtMs <= Date.now() + ACCOUNT_SESSION_REFRESH_SKEW_MS
    ) {
      return refreshAccountSession(
        config,
        credential,
        accessTokenProvider,
        logger,
      );
    }

    const refreshAfterMs = Date.parse(session.refreshAfter);
    if (Number.isFinite(refreshAfterMs) && refreshAfterMs <= Date.now()) {
      return refreshAccountSession(
        config,
        credential,
        accessTokenProvider,
        logger,
      ).catch((error) => {
        logger?.warn(
          'http',
          error instanceof Error
            ? `Agent account session refresh failed: ${error.message}`
            : 'Agent account session refresh failed',
        );
        return session;
      });
    }

    return session;
  }) as AgentBackendAccountSessionProvider;

  provider.refresh = () =>
    refreshAccountSession(config, undefined, accessTokenProvider, logger);

  return provider;
}

async function getAccessToken(
  config: AgentCliConfig,
  logger?: AgentLogger,
  notifyRefresh?: (token: string) => void,
): Promise<string | undefined> {
  const credential = await loadCredential(config);
  if (!needsRefresh(credential)) {
    return credential.accessToken;
  }

  logger?.trace('http', 'OAuth access token is near expiry; refreshing');
  return refreshCredential(config, credential, logger, notifyRefresh).then(
    (next) => next.accessToken,
  );
}

async function refreshAccessToken(
  config: AgentCliConfig,
  logger?: AgentLogger,
  notifyRefresh?: (token: string) => void,
): Promise<string | undefined> {
  const credential = await loadCredential(config);
  return refreshCredential(config, credential, logger, notifyRefresh).then(
    (next) => next.accessToken,
  );
}

async function loadCredential(
  config: AgentCliConfig,
): Promise<StoredOAuthCredential> {
  if (!config.auth) {
    throw new Error(
      'AUTH_AGENT_CREDENTIAL_REQUIRED: run grepmind auth login --hostname <host>',
    );
  }

  const store = createCredentialStore();
  const credential = await store.get(config.auth.credentialStoreKey);
  if (!credential) {
    throw new Error(
      'AUTH_AGENT_CREDENTIAL_REQUIRED: stored Grepmind CLI OAuth credential was not found',
    );
  }

  return credential;
}

async function refreshCredential(
  config: AgentCliConfig,
  credential: StoredOAuthCredential,
  logger?: AgentLogger,
  notifyRefresh?: (token: string) => void,
): Promise<StoredOAuthCredential> {
  const authClient = new AgentAuthClient({ baseUrl: credential.apiBaseUrl });
  const response = await authClient.refreshToken({
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.oauthClientId,
    refreshToken: credential.refreshToken,
    scope: credential.scopes.join(' '),
  });
  if (!response.access_token) {
    throw new Error(
      'AUTH_REFRESH_FAILED: refresh response did not include an access token',
    );
  }
  if (response.token_type?.toLowerCase() !== 'bearer') {
    throw new Error(
      'AUTH_REFRESH_FAILED: refresh response token_type must be Bearer',
    );
  }
  if (typeof response.expires_in !== 'number' || response.expires_in <= 0) {
    throw new Error(
      'AUTH_REFRESH_FAILED: refresh response did not include a valid expires_in',
    );
  }

  const nextCredential: StoredOAuthCredential = {
    ...credential,
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? credential.refreshToken,
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
  };

  const store = createCredentialStore();
  await store.set(config.auth!.credentialStoreKey, nextCredential);
  config.auth = {
    ...config.auth!,
    expiresAt: nextCredential.expiresAt,
  };
  await saveAgentCliConfig(config);
  notifyRefresh?.(nextCredential.accessToken);
  logger?.trace('http', 'OAuth access token refreshed');
  return nextCredential;
}

async function refreshAccountSession(
  config: AgentCliConfig,
  credentialInput: StoredOAuthCredential | undefined,
  accessTokenProvider: AgentBackendAccessTokenProvider,
  logger?: AgentLogger,
): Promise<Awaited<ReturnType<AgentBackendAccountSessionProvider>>> {
  const credential = credentialInput ?? (await loadCredential(config));
  const current = normalizeAccountSessionCredential(
    credential.accountSession,
    config.deviceId,
  );
  if (!current?.token) {
    return { deviceId: config.deviceId };
  }

  const accessToken =
    (await accessTokenProvider()) ??
    (await accessTokenProvider.refresh?.()) ??
    null;
  if (!accessToken) {
    throw new Error('AUTH_AGENT_CREDENTIAL_REQUIRED: OAuth token unavailable');
  }

  const response = await fetch(
    `${credential.apiBaseUrl.replace(/\/+$/, '')}/api/agent/account-sessions/refresh`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        [AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER]:
          AGENT_ACCOUNT_SESSION_CAPABILITY,
        [AGENT_ACCOUNT_SESSION_DEVICE_HEADER]: current.deviceId,
        [AGENT_ACCOUNT_SESSION_HEADER]: current.token,
      },
      body: '{}',
    },
  );
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new Error(
      `${payload.code ?? 'AGENT_ACCOUNT_SESSION_REFRESH_FAILED'}: ${
        payload.message ?? `HTTP ${response.status}`
      }`,
    );
  }

  const payload = (await response.json()) as AgentAccountSessionResponse;
  const nextSession = normalizeAccountSessionResponse(payload, current.deviceId);
  const nextCredential: StoredOAuthCredential = {
    ...credential,
    accountSession: {
      token: nextSession.token!,
      deviceId: nextSession.deviceId,
      expiresAt: nextSession.expiresAt!,
      refreshAfter: nextSession.refreshAfter!,
      account: nextSession.account!,
    },
  };
  await createCredentialStore().set(
    config.auth!.credentialStoreKey,
    nextCredential,
  );
  logger?.trace('http', 'Agent account session refreshed');
  return nextSession;
}

function needsRefresh(credential: StoredOAuthCredential): boolean {
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt - Date.now() <= REFRESH_SKEW_MS;
}

function normalizeAccountSessionCredential(
  session: StoredOAuthCredential['accountSession'] | undefined,
  fallbackDeviceId: string,
) {
  if (!session) {
    return null;
  }

  return {
    token: session.token,
    deviceId: session.deviceId || fallbackDeviceId,
    expiresAt: session.expiresAt,
    refreshAfter: session.refreshAfter,
    account: session.account,
  };
}

function normalizeAccountSessionResponse(
  payload: AgentAccountSessionResponse,
  deviceId: string,
) {
  if (
    typeof payload.accountSessionToken !== 'string' ||
    typeof payload.expiresAt !== 'string' ||
    typeof payload.refreshAfter !== 'string' ||
    !payload.account ||
    typeof payload.account.accountId !== 'number' ||
    typeof payload.account.displayName !== 'string'
  ) {
    throw new Error('AGENT_ACCOUNT_SESSION_INVALID: refresh response invalid');
  }

  return {
    token: payload.accountSessionToken,
    deviceId,
    expiresAt: payload.expiresAt,
    refreshAfter: payload.refreshAfter,
    account: {
      accountId: payload.account.accountId,
      displayName: payload.account.displayName,
      clerkOrgSlug:
        typeof payload.account.clerkOrgSlug === 'string'
          ? payload.account.clerkOrgSlug
          : null,
    },
  };
}

async function readErrorPayload(
  response: Response,
): Promise<{ code?: string; message?: string }> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    return {
      code:
        typeof parsed.code === 'string'
          ? parsed.code
          : typeof parsed.error?.code === 'string'
            ? parsed.error.code
            : undefined,
      message:
        typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : undefined,
    };
  } catch {
    return { message: text };
  }
}
