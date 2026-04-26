import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = 'grepmind-agent';

export interface StoredOAuthCredential {
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
}

export interface CredentialStore {
  kind(): string;
  get(key: string): Promise<StoredOAuthCredential | null>;
  set(key: string, credential: StoredOAuthCredential): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createCredentialStore(): CredentialStore {
  if (process.platform === 'darwin') {
    return new MacOSKeychainCredentialStore();
  }

  return new UnsupportedCredentialStore();
}

class UnsupportedCredentialStore implements CredentialStore {
  kind(): string {
    return 'unsupported';
  }

  async get(): Promise<StoredOAuthCredential | null> {
    throw new Error(
      `AUTH_SECURE_STORAGE_UNAVAILABLE: secure credential storage is not implemented on ${process.platform}`,
    );
  }

  async set(): Promise<void> {
    throw new Error(
      `AUTH_SECURE_STORAGE_UNAVAILABLE: secure credential storage is not implemented on ${process.platform}`,
    );
  }

  async delete(): Promise<void> {
    throw new Error(
      `AUTH_SECURE_STORAGE_UNAVAILABLE: secure credential storage is not implemented on ${process.platform}`,
    );
  }
}

class MacOSKeychainCredentialStore implements CredentialStore {
  kind(): string {
    return 'macos-keychain';
  }

  async get(key: string): Promise<StoredOAuthCredential | null> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        key,
        '-w',
      ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return parseCredential(stdout);
    } catch (error) {
      if (isSecurityItemNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async set(key: string, credential: StoredOAuthCredential): Promise<void> {
    await execFileAsync('/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      key,
      '-w',
      JSON.stringify(credential),
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  }

  async delete(key: string): Promise<void> {
    try {
      await execFileAsync('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        key,
      ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if (!isSecurityItemNotFound(error)) {
        throw error;
      }
    }
  }
}

export function buildCredentialStoreKey(input: {
  host: string;
  accountSubject: string | null;
  nonce: string;
}): string {
  const subject = input.accountSubject?.trim() || 'unknown';
  return `${os.userInfo().username}:${input.host}:${subject}:${input.nonce}`;
}

function parseCredential(raw: string): StoredOAuthCredential {
  const parsed = JSON.parse(raw.trim()) as Partial<StoredOAuthCredential>;
  if (
    parsed.credentialType !== 'oauth_token'
    || typeof parsed.host !== 'string'
    || typeof parsed.apiBaseUrl !== 'string'
    || typeof parsed.accessToken !== 'string'
    || typeof parsed.refreshToken !== 'string'
    || typeof parsed.tokenEndpoint !== 'string'
    || typeof parsed.oauthClientId !== 'string'
    || typeof parsed.expiresAt !== 'string'
    || !Array.isArray(parsed.scopes)
  ) {
    throw new Error('AUTH_CREDENTIAL_INVALID: secure credential payload is invalid');
  }

  return {
    credentialType: 'oauth_token',
    host: parsed.host,
    apiBaseUrl: parsed.apiBaseUrl,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    tokenEndpoint: parsed.tokenEndpoint,
    ...(typeof parsed.userInfoEndpoint === 'string' ? { userInfoEndpoint: parsed.userInfoEndpoint } : {}),
    oauthClientId: parsed.oauthClientId,
    scopes: parsed.scopes.filter((scope): scope is string => typeof scope === 'string'),
    expiresAt: parsed.expiresAt,
    accountSubject:
      typeof parsed.accountSubject === 'string' ? parsed.accountSubject : null,
    accountEmail:
      typeof parsed.accountEmail === 'string' ? parsed.accountEmail : null,
  };
}

function isSecurityItemNotFound(error: unknown): boolean {
  return error instanceof Error && /could not be found|The specified item could not be found/i.test(error.message);
}
