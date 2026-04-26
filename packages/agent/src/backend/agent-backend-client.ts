import process from 'node:process';
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
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly traceHttp: boolean;
  private readonly logger: AgentLogger;

  constructor(options: AgentBackendClientOptions) {
    this.baseUrl = String(options.baseUrl).replace(/\/$/, '');
    this.accessToken = options.accessToken;
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
    if (response.status === 401 && (await this.forceRefreshAccessToken())) {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: await this.buildHeaders(options.body !== undefined),
        body,
      });
    }

    if (!response.ok) {
      if (this.traceHttp) {
        this.logger.trace(
          'http',
          `response ${method} ${path} status=${response.status} durationMs=${Date.now() - startedAt}`,
        );
      }
      throw await this.toError(response);
    }

    if (this.traceHttp) {
      this.logger.trace(
        'http',
        `response ${method} ${path} status=${response.status} durationMs=${Date.now() - startedAt}`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
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

    return headers;
  }

  private async resolveAccessToken(): Promise<string | undefined> {
    return this.accessToken?.();
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
        details: payload?.error?.details,
      },
    );
  }
}
