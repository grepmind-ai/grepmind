export const AGENT_ACCOUNT_SESSION_HEADER = 'x-grepmind-agent-account-session';
export const AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER =
  'x-grepmind-agent-capability';
export const AGENT_ACCOUNT_SESSION_DEVICE_HEADER = 'x-grepmind-agent-device-id';
export const AGENT_ACCOUNT_SESSION_CAPABILITY = 'account-session/v1';

export const AGENT_ACCOUNT_SESSION_ERROR_CODES = [
  'AGENT_ACCOUNT_SESSION_REQUIRED',
  'AGENT_ACCOUNT_SESSION_EXPIRED',
  'AGENT_ACCOUNT_SESSION_REVOKED',
  'AGENT_UPGRADE_REQUIRED',
] as const;

export type AgentAccountSessionErrorCode =
  (typeof AGENT_ACCOUNT_SESSION_ERROR_CODES)[number];

export interface AgentAccountSessionAccount {
  accountId: number;
  displayName: string;
  clerkOrgSlug: string | null;
}

export interface AgentBackendAccountSessionCredential {
  token?: string;
  deviceId: string;
  expiresAt?: string;
  refreshAfter?: string;
  account?: AgentAccountSessionAccount;
}

export type AgentBackendAccountSessionProvider = (() =>
  | AgentBackendAccountSessionCredential
  | undefined
  | Promise<AgentBackendAccountSessionCredential | undefined>) & {
  refresh?: () =>
    | AgentBackendAccountSessionCredential
    | undefined
    | Promise<AgentBackendAccountSessionCredential | undefined>;
};

export interface AgentAccountSessionResponse {
  accountSessionToken: string;
  expiresAt: string;
  refreshAfter: string;
  account: AgentAccountSessionAccount;
}

export function isAgentAccountSessionErrorCode(
  code: string,
): code is AgentAccountSessionErrorCode {
  return (AGENT_ACCOUNT_SESSION_ERROR_CODES as readonly string[]).includes(
    code,
  );
}
