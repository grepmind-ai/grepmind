import { AgentAuthClient } from '../backend/agent-auth-client.js';
import type { AgentBackendAccessTokenProvider } from '../backend/agent-backend-client.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import type { AgentCliConfig } from './config.js';
import { saveAgentCliConfig } from './config.js';
import {
  createCredentialStore,
  type StoredOAuthCredential,
} from './credential-store.js';

const REFRESH_SKEW_MS = 5 * 60 * 1000;

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
  if (response.token_type !== 'Bearer') {
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

function needsRefresh(credential: StoredOAuthCredential): boolean {
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt - Date.now() <= REFRESH_SKEW_MS;
}
