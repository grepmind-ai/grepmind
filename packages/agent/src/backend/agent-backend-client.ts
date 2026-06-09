import process from 'node:process';
import {
  AGENT_ACCOUNT_SESSION_CAPABILITY,
  AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER,
  AGENT_ACCOUNT_SESSION_DEVICE_HEADER,
  AGENT_ACCOUNT_SESSION_HEADER,
  isAgentAccountSessionErrorCode,
  type AgentBackendAccountSessionProvider,
} from './account-session.js';
import { noopAgentLogger, type AgentLogger } from '../logging/agent-logger.js';
import type {
  AttachAgentSourceRequest,
  AttachAgentSourceResponse,
  AgentBackendBaseUrl,
  BootstrapResponse,
  GetBindingSourceResponse,
  GetArtifactsBatchRequest,
  GetArtifactsBatchResponse,
  GetProjectResponse,
  HeadSyncRequest,
  HeadSyncResponse,
  ListProjectsResponse,
  ListRevisionFilesPageResponse,
  RegisterProjectRequest,
  RegisterProjectResponse,
  SyncProjectRequest,
  SyncProjectResponse,
} from './contracts/index.js';

export type AgentBackendAccessTokenProvider = (() =>
  | string
  | undefined
  | Promise<string | undefined>) & {
  refresh?: () => string | undefined | Promise<string | undefined>;
  onRefresh?: (listener: (token: string) => void) => () => void;
};

export interface AgentBackendClientOptions {
  baseUrl: AgentBackendBaseUrl;
  accessToken?: AgentBackendAccessTokenProvider;
  accountSession?: AgentBackendAccountSessionProvider;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  logger?: AgentLogger;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

interface AgentErrorPayload {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    nextAction?: string | null;
    accountStatus?: string;
    quota?: unknown;
    retryAfterMs?: number | null;
    details?: unknown;
  };
}

export class AgentBackendClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    message: string,
    options: {
      status: number;
      code: string;
      retryable?: boolean;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = 'AgentBackendClientError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? options.status >= 500;
    this.details = options.details;
  }
}

export class AgentBackendClient {
  private readonly baseUrl: string;
  private readonly accessToken?: AgentBackendClientOptions['accessToken'];
  private readonly accountSession?: AgentBackendAccountSessionProvider;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly traceHttp: boolean;
  private readonly logger: AgentLogger;

  constructor(options: AgentBackendClientOptions) {
    this.baseUrl = String(options.baseUrl).replace(/\/$/, '');
    this.accessToken = options.accessToken;
    this.accountSession = options.accountSession;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? noopAgentLogger;
    this.traceHttp = process.env.GREPMIND_AGENT_TRACE_HTTP === '1';
  }

  async bootstrap(): Promise<BootstrapResponse> {
    return this.request<BootstrapResponse>('/api/agent/v1/bootstrap');
  }

  async registerProject(
    input: RegisterProjectRequest,
  ): Promise<RegisterProjectResponse> {
    return this.request<RegisterProjectResponse>(
      '/api/agent/v1/projects/register',
      {
        method: 'POST',
        body: input,
      },
    );
  }

  async listProjects(): Promise<ListProjectsResponse['items']> {
    const response = await this.request<ListProjectsResponse>(
      '/api/agent/v1/projects',
    );
    return response.items;
  }

  async getProject(bindingId: number): Promise<GetProjectResponse> {
    return this.request<GetProjectResponse>(
      `/api/agent/v1/projects/${bindingId}`,
    );
  }

  async unregisterProject(bindingId: number): Promise<void> {
    await this.request<void>(`/api/agent/v1/projects/${bindingId}`, {
      method: 'DELETE',
    });
  }

  async syncProject(
    bindingId: number,
    input: SyncProjectRequest,
  ): Promise<SyncProjectResponse> {
    return this.request<SyncProjectResponse>(
      `/api/agent/v1/projects/${bindingId}/sync`,
      {
        method: 'POST',
        body: input,
      },
    );
  }

  async attachSource(
    bindingId: number,
    input: AttachAgentSourceRequest,
  ): Promise<AttachAgentSourceResponse> {
    return this.request<AttachAgentSourceResponse>(
      `/api/agent/v1/projects/${bindingId}/source/attach`,
      {
        method: 'POST',
        body: input,
      },
    );
  }

  async getSource(bindingId: number): Promise<GetBindingSourceResponse> {
    return this.request<GetBindingSourceResponse>(
      `/api/agent/v1/projects/${bindingId}/source`,
    );
  }

  async syncHead(
    bindingId: number,
    input: HeadSyncRequest,
  ): Promise<HeadSyncResponse> {
    return this.request<HeadSyncResponse>(
      `/api/agent/v1/projects/${bindingId}/head`,
      {
        method: 'POST',
        body: input,
      },
    );
  }

  async listRevisionFilesPage(
    bindingId: number,
    revisionId: number,
    cursor?: string,
    limit?: number,
  ): Promise<ListRevisionFilesPageResponse> {
    const searchParams = new URLSearchParams();
    if (cursor) {
      searchParams.set('cursor', cursor);
    }
    if (limit != null) {
      searchParams.set('limit', String(limit));
    }

    const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : '';
    return this.request<ListRevisionFilesPageResponse>(
      `/api/agent/v1/projects/${bindingId}/revisions/${revisionId}/files${suffix}`,
    );
  }

  async getArtifactsBatch(
    bindingId: number,
    input: GetArtifactsBatchRequest,
  ): Promise<GetArtifactsBatchResponse> {
    return this.request<GetArtifactsBatchResponse>(
      `/api/agent/v1/projects/${bindingId}/artifacts:batchGet`,
      {
        method: 'POST',
        body: input,
      },
    );
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const startedAt = Date.now();
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    if (this.traceHttp) {
      this.logger.trace('http', `request ${method} ${path}`);
    }
    const headers = await this.buildHeaders(options.body !== undefined);
    let response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
    });
    if (!response.ok) {
      let error = await this.toError(response);
      if (
        error.status === 401 &&
        !isAgentAccountSessionErrorCode(error.code) &&
        (await this.forceRefreshAccessToken())
      ) {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: await this.buildHeaders(options.body !== undefined),
          body,
        });
        if (response.ok) {
          return this.readResponse<T>(response);
        }
        error = await this.toError(response);
      }

      if (
        error.code === 'AGENT_ACCOUNT_SESSION_EXPIRED' &&
        (await this.forceRefreshAccountSession())
      ) {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: await this.buildHeaders(options.body !== undefined),
          body,
        });
        if (response.ok) {
          return this.readResponse<T>(response);
        }
        error = await this.toError(response);
      }

      if (this.traceHttp) {
        this.logger.trace(
          'http',
          `response ${method} ${path} status=${response.status} durationMs=${Date.now() - startedAt}`,
        );
      }
      throw error;
    }

    if (this.traceHttp) {
      this.logger.trace(
        'http',
        `response ${method} ${path} status=${response.status} durationMs=${Date.now() - startedAt}`,
      );
    }

    return this.readResponse<T>(response);
  }

  private async buildHeaders(
    hasJsonBody: boolean,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
    };

    if (hasJsonBody) {
      headers['Content-Type'] = 'application/json';
    }

    const token = await this.resolveAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const accountSession = await this.resolveAccountSession();
    if (accountSession) {
      headers[AGENT_ACCOUNT_SESSION_CAPABILITY_HEADER] =
        AGENT_ACCOUNT_SESSION_CAPABILITY;
      headers[AGENT_ACCOUNT_SESSION_DEVICE_HEADER] = accountSession.deviceId;
      if (accountSession.token) {
        headers[AGENT_ACCOUNT_SESSION_HEADER] = accountSession.token;
      }
    }

    return headers;
  }

  private async resolveAccessToken(): Promise<string | undefined> {
    return this.accessToken?.();
  }

  private async resolveAccountSession() {
    return this.accountSession?.();
  }

  private async forceRefreshAccessToken(): Promise<boolean> {
    if (typeof this.accessToken !== 'function' || !this.accessToken.refresh) {
      return false;
    }

    try {
      const token = await this.accessToken.refresh();
      return Boolean(token);
    } catch (error) {
      this.logger.warn(
        'http',
        error instanceof Error
          ? `OAuth token refresh failed: ${error.message}`
          : 'OAuth token refresh failed',
      );
      return false;
    }
  }

  private async forceRefreshAccountSession(): Promise<boolean> {
    if (!this.accountSession?.refresh) {
      return false;
    }

    try {
      const credential = await this.accountSession.refresh();
      return Boolean(credential?.token);
    } catch (error) {
      this.logger.warn(
        'http',
        error instanceof Error
          ? `Agent account session refresh failed: ${error.message}`
          : 'Agent account session refresh failed',
      );
      return false;
    }
  }

  private async readResponse<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async toError(response: Response): Promise<AgentBackendClientError> {
    let payload: AgentErrorPayload | undefined;
    let fallbackBody: string | undefined;

    try {
      payload = (await response.json()) as AgentErrorPayload;
    } catch {
      fallbackBody = await response.text().catch(() => '');
    }

    return new AgentBackendClientError(
      payload?.error?.message ??
        fallbackBody ??
        `Agent backend request failed with status ${response.status}`,
      {
        status: response.status,
        code: payload?.error?.code ?? 'RETRYABLE_BACKEND_ERROR',
        retryable: payload?.error?.retryable,
        details: normalizeBackendErrorDetails(payload?.error),
      },
    );
  }
}

function normalizeBackendErrorDetails(
  error: AgentErrorPayload['error'] | undefined,
): unknown {
  if (!error) {
    return undefined;
  }

  const details: Record<string, unknown> = isRecord(error.details)
    ? { ...error.details }
    : error.details == null
      ? {}
      : { value: error.details };

  if (error.nextAction !== undefined) {
    details.nextAction = error.nextAction;
  }
  if (error.accountStatus) {
    details.accountStatus = error.accountStatus;
  }
  if (error.quota !== undefined) {
    details.quota = error.quota;
  }
  if (error.retryAfterMs !== undefined) {
    details.retryAfterMs = error.retryAfterMs;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
