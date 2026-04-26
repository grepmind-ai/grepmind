export interface AgentAuthMetadataResponse {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint?: string;
  clientId: string;
  expectedTokenType: 'oauth_token';
  tokenFormat: 'opaque';
  scopes: string[];
  supportsPkceLocalhost: boolean;
  supportsDeviceCode: boolean;
  supportsRefreshToken: boolean;
  redirectUriStrategy: 'loopback_fixed_ports';
  callbackHost: '127.0.0.1';
  callbackPath: '/oauth/callback';
  callbackPorts: number[];
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number | null;
}

export interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface OAuthUserInfoResponse {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}
