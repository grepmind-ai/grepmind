import type {
  AgentAccountSessionStatus,
  AgentCredentialStatus,
} from './bootstrap.js';

export interface AgentCredentialInspection {
  status: AgentCredentialStatus;
  accountSessionStatus: AgentAccountSessionStatus;
  accountSessionExpiresAt: string | null;
  selectedAccountId: number | null;
  selectedAccountName: string | null;
}

export function inspectCredentialPayload(
  raw: string,
): AgentCredentialInspection {
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    const validCredential =
      parsed.credentialType === 'oauth_token' &&
      typeof parsed.host === 'string' &&
      typeof parsed.apiBaseUrl === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.tokenEndpoint === 'string' &&
      typeof parsed.oauthClientId === 'string' &&
      typeof parsed.expiresAt === 'string';
    if (!validCredential) {
      return emptyCredentialInspection('invalid', 'invalid');
    }

    const accountSession = parsed.accountSession;
    if (
      !accountSession ||
      typeof accountSession !== 'object' ||
      Array.isArray(accountSession)
    ) {
      return emptyCredentialInspection('available', 'missing');
    }

    const session = accountSession as Record<string, unknown>;
    const account =
      session.account &&
      typeof session.account === 'object' &&
      !Array.isArray(session.account)
        ? (session.account as Record<string, unknown>)
        : null;
    if (
      typeof session.token !== 'string' ||
      typeof session.deviceId !== 'string' ||
      typeof session.expiresAt !== 'string' ||
      typeof session.refreshAfter !== 'string' ||
      !account ||
      typeof account.accountId !== 'number' ||
      typeof account.displayName !== 'string'
    ) {
      return emptyCredentialInspection('available', 'invalid');
    }

    const expiresAtMs = Date.parse(session.expiresAt);
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
    return {
      status: 'available',
      accountSessionStatus: expired ? 'expired' : 'available',
      accountSessionExpiresAt: session.expiresAt,
      selectedAccountId: account.accountId,
      selectedAccountName: account.displayName,
    };
  } catch {
    return emptyCredentialInspection('invalid', 'invalid');
  }
}

export function emptyCredentialInspection(
  status: AgentCredentialStatus,
  accountSessionStatus: AgentAccountSessionStatus,
): AgentCredentialInspection {
  return {
    status,
    accountSessionStatus,
    accountSessionExpiresAt: null,
    selectedAccountId: null,
    selectedAccountName: null,
  };
}
