import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentCliAuthConfig, AgentCredentialStatus } from './bootstrap.js';
import {
  inspectCredentialPayload,
  type AgentCredentialInspection,
} from './credential-inspection.js';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = 'grepmind-agent';

export async function inspectCredential(
  auth: AgentCliAuthConfig,
): Promise<AgentCredentialInspection> {
  if (process.platform !== 'darwin') {
    const status: AgentCredentialStatus =
      auth.credentialStoreKind === 'unsupported'
        ? 'unsupported'
        : 'unavailable';
    return {
      status,
      accountSessionStatus: status,
      accountSessionExpiresAt: null,
      selectedAccountId: null,
      selectedAccountName: null,
    };
  }

  try {
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
    return inspectCredentialPayload(stdout);
  } catch (error) {
    if (isSecurityItemNotFound(error)) {
      return {
        status: 'missing',
        accountSessionStatus: 'missing',
        accountSessionExpiresAt: null,
        selectedAccountId: null,
        selectedAccountName: null,
      };
    }
    return {
      status: 'unavailable',
      accountSessionStatus: 'unavailable',
      accountSessionExpiresAt: null,
      selectedAccountId: null,
      selectedAccountName: null,
    };
  }
}

function isSecurityItemNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    /could not be found|The specified item could not be found/i.test(
      error.message,
    )
  );
}
