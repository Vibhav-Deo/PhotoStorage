/**
 * Authentication service — sign in with Google, Apple, and Facebook via Cognito
 * User Pool hosted UI. Sign in with Apple is mandatory once other social providers
 * are offered (App Store Guideline 4.8).
 *
 * This module produces an ID token (JWT) and the Cognito identity sub. Task 4.3
 * (CredentialProvider) exchanges the ID token for STS credentials scoped to that sub.
 *
 * Requirements: 13.1
 */

import * as ExpoAuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

// Required for expo-auth-session on Android.
WebBrowser.maybeCompleteAuthSession();

export type AuthProvider = 'Google' | 'Apple' | 'Facebook';

export interface AuthTokens {
  /** Cognito ID token (JWT). Passed to Identity Pool for STS credential exchange. */
  readonly idToken: string;
  /** Cognito access token. Used for User Pool API calls. */
  readonly accessToken: string;
  /** Epoch seconds when the tokens expire. */
  readonly expiresAt: number;
}

export interface SignInSession {
  readonly tokens: AuthTokens;
  /** Cognito identity sub — the IAM policy boundary and S3 key prefix. */
  readonly sub: string;
  readonly provider: AuthProvider;
}

export interface CognitoConfig {
  /** Cognito User Pool domain, e.g. "photo-archive.auth.us-east-1.amazoncognito.com" */
  readonly domain: string;
  /** App client ID (public client, no secret). */
  readonly clientId: string;
  /** AWS region. */
  readonly region: string;
}

export class AuthError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AuthError';
    this.cause = cause;
  }
}

/**
 * Extracts the `sub` claim from a Cognito ID token without verifying the signature.
 * Signature verification happens server-side in the sync Lambda (task 3.4).
 * On the client we trust the token we just received from Cognito's own endpoint.
 */
function subFromIdToken(idToken: string): string {
  const parts = idToken.split('.');
  const payload = parts[1];
  if (!payload) throw new AuthError('Malformed ID token: missing payload segment');
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >;
    if (typeof json['sub'] !== 'string' || !json['sub']) {
      throw new AuthError('ID token missing sub claim');
    }
    return json['sub'];
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('Failed to decode ID token payload', err);
  }
}

/**
 * Builds the Cognito hosted UI authorization URL for a given social provider.
 * The hosted UI handles the provider-specific OAuth dance and returns a Cognito
 * authorization code that we exchange for tokens.
 */
function buildAuthRequest(
  config: CognitoConfig,
  provider: AuthProvider,
  redirectUri: string,
): ExpoAuthSession.AuthRequest {
  return new ExpoAuthSession.AuthRequest({
    clientId: config.clientId,
    scopes: ['openid', 'email', 'profile'],
    redirectUri,
    responseType: ExpoAuthSession.ResponseType.Code,
    extraParams: {
      identity_provider: provider,
    },
  });
}

/**
 * Exchanges a Cognito authorization code for ID + access tokens via the token endpoint.
 */
async function exchangeCodeForTokens(
  config: CognitoConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<AuthTokens> {
  const tokenEndpoint = `https://${config.domain}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AuthError(`Token exchange failed (${String(response.status)}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data['id_token'] !== 'string' || typeof data['access_token'] !== 'string') {
    throw new AuthError('Token response missing id_token or access_token');
  }

  const expiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600;

  return {
    idToken: data['id_token'],
    accessToken: data['access_token'],
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

/**
 * Refreshes tokens using a refresh token.
 */
export async function refreshTokens(
  config: CognitoConfig,
  refreshToken: string,
): Promise<AuthTokens> {
  const tokenEndpoint = `https://${config.domain}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AuthError(`Token refresh failed (${String(response.status)}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data['id_token'] !== 'string' || typeof data['access_token'] !== 'string') {
    throw new AuthError('Refresh response missing id_token or access_token');
  }

  const expiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600;

  return {
    idToken: data['id_token'],
    accessToken: data['access_token'],
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

/**
 * Signs in with the given social provider via Cognito hosted UI.
 * Opens the system browser, completes the OAuth flow, and returns an AuthSession.
 */
export async function signIn(
  config: CognitoConfig,
  provider: AuthProvider,
): Promise<SignInSession> {
  const redirectUri = ExpoAuthSession.makeRedirectUri({ scheme: 'photoarchive' });
  const request = buildAuthRequest(config, provider, redirectUri);

  const discovery = {
    authorizationEndpoint: `https://${config.domain}/oauth2/authorize`,
    tokenEndpoint: `https://${config.domain}/oauth2/token`,
    revocationEndpoint: `https://${config.domain}/oauth2/revoke`,
  };

  const result = await request.promptAsync(discovery);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new AuthError(`Sign-in cancelled by user`);
  }
  if (result.type === 'error') {
    throw new AuthError(`Sign-in error: ${result.error?.message ?? 'unknown'}`, result.error);
  }
  if (result.type !== 'success' || !result.params['code']) {
    throw new AuthError(`Unexpected auth result type: ${result.type}`);
  }

  const codeVerifier = request.codeVerifier;
  if (!codeVerifier) throw new AuthError('PKCE code verifier missing');

  const tokens = await exchangeCodeForTokens(
    config,
    result.params['code'],
    redirectUri,
    codeVerifier,
  );

  const sub = subFromIdToken(tokens.idToken);

  return { tokens, sub, provider };
}

/**
 * Signs out by revoking the access token at the Cognito revocation endpoint.
 */
export async function signOut(config: CognitoConfig, accessToken: string): Promise<void> {
  const revocationEndpoint = `https://${config.domain}/oauth2/revoke`;
  const body = new URLSearchParams({
    token: accessToken,
    client_id: config.clientId,
  });

  await fetch(revocationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }).catch(() => {
    // Best-effort revocation — local session is cleared regardless.
  });
}
