import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { AgentAuthStatus, AgentCliAuthConfig } from './bootstrap.js';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = 'grepmind-agent';
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AGENT_ACCOUNT_SESSION_HEADER = 'x-grepmind-agent-account-session';
const AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER = 'x-grepmind-agent-capability';
const AGENT_ACCOUNT_SESSION_DEVICE_HEADER = 'x-grepmind-agent-device-id';
const AGENT_ACCOUNT_SESSION_CAPABILITY = 'account-session/v1';

interface StoredAgentAccountSession {
  token: string;
  deviceId: string;
  expiresAt: string;
  refreshAfter: string;
  account: {
    accountId: number;
    displayName: string;
    clerkOrgSlug: string | null;
  };
}

interface StoredOAuthCredential {
  credentialType: 'oauth_token';
  host: string;
  apiBaseUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenEndpoint: string;
  userInfoEndpoint?: string;
  oauthClientId: string;
  scopes: string[];
  expiresAt: string;
  accountSubject: string | null;
  accountEmail: string | null;
  accountSession?: StoredAgentAccountSession;
}

export async function refreshExpiredAccountSessionIfPossible(
  status: AgentAuthStatus,
): Promise<boolean> {
  const config = status.config;
  const auth = config?.auth;
  if (
    status.credentialStatus !== 'available' ||
    status.accountSessionStatus !== 'expired' ||
    !config ||
    !auth
  ) {
    return false;
  }

  try {
    const credential = await loadStoredCredential(auth);
    if (!credential.accountSession) {
      return false;
    }

    const credentialWithFreshAccessToken = await refreshOAuthCredentialIfNeeded(
      auth,
      status.configPath,
      credential,
    );
    const accountSession = await refreshStoredAccountSession(
      credentialWithFreshAccessToken,
    );
    await saveStoredCredential(auth.credentialStoreKey, {
      ...credentialWithFreshAccessToken,
      accountSession,
    });
    return true;
  } catch {
    return false;
  }
}

async function refreshOAuthCredentialIfNeeded(
  auth: AgentCliAuthConfig,
  configPath: string,
  credential: StoredOAuthCredential,
): Promise<StoredOAuthCredential> {
  if (!needsOAuthRefresh(credential.expiresAt)) {
    return credential;
  }

  const response = await fetch(credential.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.oauthClientId,
      refresh_token: credential.refreshToken,
      ...(credential.scopes.length > 0
        ? { scope: credential.scopes.join(' ') }
        : {}),
    }),
  });
  const payload = await readJsonObject(response);
  if (!response.ok || typeof payload.error === 'string') {
    throw new Error(
      `AUTH_REFRESH_FAILED: ${
        typeof payload.error_description === 'string'
          ? payload.error_description
          : typeof payload.error === 'string'
            ? payload.error
            : `HTTP ${response.status}`
      }`,
    );
  }
  if (typeof payload.access_token !== 'string') {
    throw new TypeError(
      'AUTH_REFRESH_FAILED: refresh response did not include an access token',
    );
  }
  if (
    typeof payload.token_type !== 'string' ||
    payload.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new TypeError(
      'AUTH_REFRESH_FAILED: refresh response token_type must be Bearer',
    );
  }
  if (typeof payload.expires_in !== 'number' || payload.expires_in <= 0) {
    throw new TypeError(
      'AUTH_REFRESH_FAILED: refresh response did not include a valid expires_in',
    );
  }

  const nextCredential: StoredOAuthCredential = {
    ...credential,
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : credential.refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
  };
  await saveStoredCredential(auth.credentialStoreKey, nextCredential);
  await updateStoredConfigAuthExpiresAt(configPath, nextCredential.expiresAt);
  return nextCredential;
}

async function refreshStoredAccountSession(
  credential: StoredOAuthCredential,
): Promise<StoredAgentAccountSession> {
  const current = credential.accountSession;
  if (!current) {
    throw new Error('AGENT_ACCOUNT_SESSION_REQUIRED: stored session missing');
  }

  const response = await fetch(
    `${credential.apiBaseUrl.replace(/\/+$/, '')}/api/agent/account-sessions/refresh`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        [AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER]:
          AGENT_ACCOUNT_SESSION_CAPABILITY,
        [AGENT_ACCOUNT_SESSION_DEVICE_HEADER]: current.deviceId,
        [AGENT_ACCOUNT_SESSION_HEADER]: current.token,
      },
      body: '{}',
    },
  );
  const payload = await readJsonObject(response);
  if (!response.ok) {
    throw new Error(
      `${
        typeof payload.code === 'string'
          ? payload.code
          : 'AGENT_ACCOUNT_SESSION_REFRESH_FAILED'
      }: ${
        typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`
      }`,
    );
  }

  return normalizeAccountSessionResponse(payload, current.deviceId);
}

function needsOAuthRefresh(expiresAt: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() + OAUTH_REFRESH_SKEW_MS
  );
}

async function loadStoredCredential(
  auth: AgentCliAuthConfig,
): Promise<StoredOAuthCredential> {
  const { stdout } = await execFileAsync(
    '/usr/bin/security',
    [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      auth.credentialStoreKey,
      '-w',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  return parseStoredCredential(stdout);
}

async function saveStoredCredential(
  credentialStoreKey: string,
  credential: StoredOAuthCredential,
): Promise<void> {
  await execFileAsync(
    '/usr/bin/security',
    [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      credentialStoreKey,
      '-w',
      JSON.stringify(credential),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

function parseStoredCredential(raw: string): StoredOAuthCredential {
  const parsed = JSON.parse(raw.trim()) as Partial<StoredOAuthCredential>;
  if (
    parsed.credentialType !== 'oauth_token' ||
    typeof parsed.host !== 'string' ||
    typeof parsed.apiBaseUrl !== 'string' ||
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.refreshToken !== 'string' ||
    typeof parsed.tokenEndpoint !== 'string' ||
    typeof parsed.oauthClientId !== 'string' ||
    typeof parsed.expiresAt !== 'string' ||
    !Array.isArray(parsed.scopes)
  ) {
    throw new TypeError(
      'AUTH_CREDENTIAL_INVALID: secure credential payload is invalid',
    );
  }

  const accountSession = normalizeStoredAccountSession(parsed.accountSession);
  return {
    credentialType: 'oauth_token',
    host: parsed.host,
    apiBaseUrl: parsed.apiBaseUrl,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    tokenEndpoint: parsed.tokenEndpoint,
    ...(typeof parsed.userInfoEndpoint === 'string'
      ? { userInfoEndpoint: parsed.userInfoEndpoint }
      : {}),
    oauthClientId: parsed.oauthClientId,
    scopes: parsed.scopes.filter(
      (scope): scope is string => typeof scope === 'string',
    ),
    expiresAt: parsed.expiresAt,
    accountSubject:
      typeof parsed.accountSubject === 'string' ? parsed.accountSubject : null,
    accountEmail:
      typeof parsed.accountEmail === 'string' ? parsed.accountEmail : null,
    ...(accountSession ? { accountSession } : {}),
  };
}

function normalizeStoredAccountSession(
  value: unknown,
): StoredAgentAccountSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<StoredAgentAccountSession>;
  return normalizeAccountSessionPayload(
    {
      accountSessionToken: record.token,
      expiresAt: record.expiresAt,
      refreshAfter: record.refreshAfter,
      account: record.account,
    },
    typeof record.deviceId === 'string' ? record.deviceId : null,
  );
}

function normalizeAccountSessionResponse(
  payload: Record<string, unknown>,
  deviceId: string,
): StoredAgentAccountSession {
  return normalizeAccountSessionPayload(payload, deviceId);
}

function normalizeAccountSessionPayload(
  payload: Record<string, unknown>,
  deviceId: string | null,
): StoredAgentAccountSession {
  const account =
    payload.account &&
    typeof payload.account === 'object' &&
    !Array.isArray(payload.account)
      ? (payload.account as Record<string, unknown>)
      : null;
  if (
    typeof payload.accountSessionToken !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof payload.expiresAt !== 'string' ||
    typeof payload.refreshAfter !== 'string' ||
    !account ||
    typeof account.accountId !== 'number' ||
    typeof account.displayName !== 'string'
  ) {
    throw new TypeError(
      'AGENT_ACCOUNT_SESSION_INVALID: session payload invalid',
    );
  }

  return {
    token: payload.accountSessionToken,
    deviceId,
    expiresAt: payload.expiresAt,
    refreshAfter: payload.refreshAfter,
    account: {
      accountId: account.accountId,
      displayName: account.displayName,
      clerkOrgSlug:
        typeof account.clerkOrgSlug === 'string' ? account.clerkOrgSlug : null,
    },
  };
}

async function updateStoredConfigAuthExpiresAt(
  configPath: string,
  expiresAt: string,
): Promise<void> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const auth =
    parsed.auth &&
    typeof parsed.auth === 'object' &&
    !Array.isArray(parsed.auth)
      ? (parsed.auth as Record<string, unknown>)
      : null;
  if (!auth) {
    return;
  }

  parsed.auth = {
    ...auth,
    expiresAt,
  };
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(configPath, 0o600).catch(() => {});
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as unknown;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}
