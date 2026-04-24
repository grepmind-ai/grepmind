import type { SearchResponsePayload, SearchTarget } from '../../backend/contracts/index.js';
import type {
  AgentStatusQuery,
  AgentStatusSnapshot,
  CleanProjectCommandResult,
  ListProjectsCommandResult,
  RegisterProjectCommandResult,
  SyncProjectCommandResult,
} from '../../commands/agent-command-executor.js';

export const AGENT_RUNTIME_PROTOCOL_VERSION = 1;

export type AgentCommandMode = 'runtime-only';

export interface AgentRuntimeMeta {
  protocolVersion: number;
  instanceId: string;
  startedAt: string;
  pid: number;
  socketPath: string;
  token: string;
}

export interface AgentRuntimePingResult {
  protocolVersion: number;
  instanceId: string;
  startedAt: string;
  pid: number;
  dataDir: string;
}

export interface RegisterProjectRpcParams {
  remoteFingerprint: string;
  displayName: string;
  workspacePath: string;
  workspaceFingerprint: string;
  preferredActiveBranch?: string;
  idempotencyKey: string;
}

export interface SyncProjectRpcParams {
  bindingId?: number;
  targets?: SearchTarget[];
  idempotencyKey: string;
}

export interface UnbindProjectRpcParams {
  bindingId: number;
  idempotencyKey: string;
}

export interface ShutdownRpcParams {
  idempotencyKey: string;
}

export interface CleanProjectRpcParams {
  bindingId: number;
  idempotencyKey: string;
}

export interface SearchHeadRpcParams {
  bindingId?: number;
  workspacePath?: string;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
}

export interface SearchHeadRpcResult extends SearchResponsePayload {
  scope: {
    bindingId: number;
    workspacePath: string;
    branch: string;
    headCommitSha: string;
    revisionId: number;
  };
}

export interface AgentRpcMethodMap {
  ping: {
    params: Record<string, never> | undefined;
    result: AgentRuntimePingResult;
  };
  status: {
    params: AgentStatusQuery;
    result: AgentStatusSnapshot;
  };
  registerProject: {
    params: RegisterProjectRpcParams;
    result: RegisterProjectCommandResult;
  };
  listProjects: {
    params: Record<string, never> | undefined;
    result: ListProjectsCommandResult;
  };
  syncProject: {
    params: SyncProjectRpcParams;
    result: SyncProjectCommandResult;
  };
  unbindProject: {
    params: UnbindProjectRpcParams;
    result: Record<string, never>;
  };
  cleanProject: {
    params: CleanProjectRpcParams;
    result: CleanProjectCommandResult;
  };
  searchHead: {
    params: SearchHeadRpcParams;
    result: SearchHeadRpcResult;
  };
  shutdown: {
    params: ShutdownRpcParams;
    result: {
      accepted: true;
    };
  };
}

export type AgentRpcMethod = keyof AgentRpcMethodMap;

export interface AgentRpcError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface AgentRpcRequest<TMethod extends AgentRpcMethod = AgentRpcMethod> {
  id: string;
  method: TMethod;
  params: AgentRpcMethodMap[TMethod]['params'];
  timeoutMs?: number;
  protocolVersion: number;
  token?: string;
}

export interface AgentRpcSuccessResponse<TMethod extends AgentRpcMethod = AgentRpcMethod> {
  id: string;
  ok: true;
  result: AgentRpcMethodMap[TMethod]['result'];
}

export interface AgentRpcFailureResponse {
  id: string;
  ok: false;
  error: AgentRpcError;
}

export type AgentRpcResponse<TMethod extends AgentRpcMethod = AgentRpcMethod> =
  | AgentRpcSuccessResponse<TMethod>
  | AgentRpcFailureResponse;

export function isMutatingRpcMethod(method: AgentRpcMethod): boolean {
  return method === 'registerProject'
    || method === 'syncProject'
    || method === 'unbindProject'
    || method === 'cleanProject'
    || method === 'shutdown';
}
