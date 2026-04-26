import type {
  AgentAuthMetadataResponse,
  OAuthTokenResponse,
  OAuthUserInfoResponse,
} from './contracts/index.js';

export interface AgentAuthClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class AgentAuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentAuthClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchAuthMetadata(): Promise<AgentAuthMetadataResponse> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/agent/v1/auth/metadata`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      throw new Error(
        `AUTH_METADATA_UNAVAILABLE: auth metadata request failed with HTTP ${response.status}`,
      );
    }

    return this.validateMetadata(
      (await response.json()) as AgentAuthMetadataResponse,
    );
  }

  async exchangeAuthorizationCode(input: {
    tokenEndpoint: string;
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokenResponse> {
    return this.postToken(input.tokenEndpoint, {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  async refreshToken(input: {
    tokenEndpoint: string;
    clientId: string;
    refreshToken: string;
    scope?: string;
  }): Promise<OAuthTokenResponse> {
    return this.postToken(input.tokenEndpoint, {
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      ...(input.scope ? { scope: input.scope } : {}),
    });
  }

  async fetchUserInfo(
    userInfoEndpoint: string,
    accessToken: string,
  ): Promise<OAuthUserInfoResponse> {
    const response = await this.fetchImpl(userInfoEndpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`AUTH_USERINFO_FAILED: userinfo request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as OAuthUserInfoResponse;
  }

  validateMetadata(
    metadata: AgentAuthMetadataResponse,
    requestedScopes: string[] = ['openid', 'profile', 'email'],
  ): AgentAuthMetadataResponse {
    const missing = [
      ['issuer', metadata.issuer],
      ['authorizationEndpoint', metadata.authorizationEndpoint],
      ['tokenEndpoint', metadata.tokenEndpoint],
      ['clientId', metadata.clientId],
    ].filter(([, value]) => typeof value !== 'string' || !value);
    if (missing.length > 0) {
      throw new Error(
        `AUTH_METADATA_INVALID: missing ${missing.map(([name]) => name).join(', ')}`,
      );
    }
    if (metadata.supportsPkceLocalhost !== true) {
      throw new Error('AUTH_METADATA_INVALID: PKCE localhost login is not supported by this host');
    }
    if (metadata.supportsDeviceCode !== false) {
      throw new Error('AUTH_METADATA_INVALID: unexpected device flow support in metadata');
    }
    if (metadata.supportsRefreshToken !== true) {
      throw new Error('AUTH_METADATA_INVALID: refresh tokens are required');
    }
    if (metadata.redirectUriStrategy !== 'loopback_fixed_ports') {
      throw new Error('AUTH_METADATA_INVALID: unsupported redirect URI strategy');
    }
    if (metadata.callbackHost !== '127.0.0.1') {
      throw new Error('AUTH_METADATA_INVALID: callback host must be 127.0.0.1');
    }
    if (metadata.callbackPath !== '/oauth/callback') {
      throw new Error('AUTH_METADATA_INVALID: callback path must be /oauth/callback');
    }
    if (metadata.expectedTokenType !== 'oauth_token') {
      throw new Error('AUTH_METADATA_INVALID: expected OAuth token type must be oauth_token');
    }
    if (metadata.tokenFormat !== 'opaque') {
      throw new Error('AUTH_METADATA_INVALID: token format must be opaque');
    }
    if (!Array.isArray(metadata.callbackPorts) || metadata.callbackPorts.length === 0) {
      throw new Error('AUTH_METADATA_INVALID: callbackPorts must be non-empty');
    }
    for (const port of metadata.callbackPorts) {
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('AUTH_METADATA_INVALID: callbackPorts contains an invalid port');
      }
    }
    const availableScopes = new Set(metadata.scopes);
    const unavailableScope = requestedScopes.find((scope) => !availableScopes.has(scope));
    if (unavailableScope) {
      throw new Error(`AUTH_METADATA_INVALID: requested scope is unavailable: ${unavailableScope}`);
    }

    return metadata;
  }

  private async postToken(
    tokenEndpoint: string,
    body: Record<string, string>,
  ): Promise<OAuthTokenResponse> {
    const response = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
    });
    const payload = (await response.json().catch(() => ({}))) as OAuthTokenResponse;
    if (!response.ok || payload.error) {
      const message = payload.error_description || payload.error || `HTTP ${response.status}`;
      throw new Error(`AUTH_TOKEN_EXCHANGE_FAILED: ${message}`);
    }
    return payload;
  }
}
