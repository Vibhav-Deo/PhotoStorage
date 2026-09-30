/**
 * CredentialProvider — exchanges a Cognito ID token for short-lived STS credentials
 * scoped to the user's S3 key prefix, caches them, and refreshes before expiry.
 *
 * On refresh failure the provider enters read-only-local mode rather than erroring,
 * so browse and search continue to work without network (Requirement 13.4, 4.6).
 *
 * This is the only component aware of the tenancy model. Everything else receives
 * credentials and a prefix from here (Requirement 13.2).
 *
 * Requirements: 13.2, 13.4
 */

import type { SignInSession } from '../auth/authService.ts';
import type { AuthTokens } from '../auth/authService.ts';
import { refreshTokens } from '../auth/authService.ts';
import type { CognitoConfig } from '../auth/authService.ts';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** Epoch seconds when the credentials expire. */
  readonly expiration: number;
}

export interface CredentialProviderConfig {
  readonly cognito: CognitoConfig;
  /** Cognito User Pool ID used as the federated login key. */
  readonly userPoolId: string;
  /** Cognito Identity Pool ID, e.g. "us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" */
  readonly identityPoolId: string;
  /** AWS region. */
  readonly region: string;
  /** Refresh tokens so the provider can renew ID tokens before exchanging for STS creds. */
  readonly refreshToken?: string;
  /** Called when a new ID token is obtained via refresh, so the caller can persist it. */
  readonly onTokensRefreshed?: (tokens: AuthTokens) => void;
}

/** Seconds before expiry at which we proactively refresh. */
const REFRESH_BUFFER_SECONDS = 300;

export class CredentialError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CredentialError';
    this.cause = cause;
  }
}

/**
 * CredentialProvider caches STS credentials and refreshes them before expiry.
 * Construct one per authenticated session; discard on sign-out.
 */
export class CredentialProvider {
  private _credentials: AwsCredentials | null = null;
  private _idToken: string;
  private _identityId: string | null = null;
  private _readOnlyLocal = false;
  private readonly _config: CredentialProviderConfig;

  constructor(session: SignInSession, config: CredentialProviderConfig) {
    this._idToken = session.tokens.idToken;
    this._config = config;
  }

  /**
   * Returns cached credentials, refreshing if they expire within REFRESH_BUFFER_SECONDS.
   * On refresh failure, enters read-only-local mode and throws CredentialError.
   */
  async credentials(): Promise<AwsCredentials> {
    const now = Math.floor(Date.now() / 1000);

    if (this._credentials && this._credentials.expiration - now > REFRESH_BUFFER_SECONDS) {
      return this._credentials;
    }

    if (this._readOnlyLocal) {
      throw new CredentialError('In read-only-local mode: credential refresh previously failed');
    }

    try {
      this._credentials = await this._fetchCredentials();
      return this._credentials;
    } catch (err) {
      this._readOnlyLocal = true;
      throw new CredentialError('Credential refresh failed; entering read-only-local mode', err);
    }
  }

  /**
   * The S3 key prefix this credential is scoped to (the Cognito identity sub).
   * Resolves the identity ID on first call.
   */
  async prefix(): Promise<string> {
    const identityId = await this._resolveIdentityId();
    // Identity ID format: "us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    // The sub used as the S3 prefix is the full identity ID.
    return identityId;
  }

  /** True when the provider has fallen back to read-only-local mode. */
  get isReadOnlyLocal(): boolean {
    return this._readOnlyLocal;
  }

  private async _resolveIdentityId(): Promise<string> {
    if (this._identityId) return this._identityId;

    // Refresh the ID token if it's close to expiry before resolving identity.
    await this._maybeRefreshIdToken();

    const logins = this._buildLogins();
    const getIdResult = await this._send<CognitoIdentityResponse>('GetId', {
      IdentityPoolId: this._config.identityPoolId,
      Logins: logins,
    });

    if (!getIdResult.IdentityId) {
      throw new CredentialError('GetId returned no IdentityId');
    }

    this._identityId = getIdResult.IdentityId;
    return this._identityId;
  }

  private async _fetchCredentials(): Promise<AwsCredentials> {
    await this._maybeRefreshIdToken();
    const identityId = await this._resolveIdentityId();
    const logins = this._buildLogins();

    const result = await this._send<CognitoIdentityResponse>('GetCredentialsForIdentity', {
      IdentityId: identityId,
      Logins: logins,
    });

    const creds = result.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretKey || !creds.SessionToken || !creds.Expiration) {
      throw new CredentialError('GetCredentialsForIdentity returned incomplete credentials');
    }

    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretKey,
      sessionToken: creds.SessionToken,
      expiration: Math.floor(creds.Expiration / 1000),
    };
  }

  private async _maybeRefreshIdToken(): Promise<void> {
    // Decode expiry from the ID token without verifying signature.
    const parts = this._idToken.split('.');
    const payload = parts[1];
    if (!payload) return;

    try {
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
        string,
        unknown
      >;
      const exp = typeof json['exp'] === 'number' ? json['exp'] : 0;
      const now = Math.floor(Date.now() / 1000);

      if (exp - now > REFRESH_BUFFER_SECONDS) return;

      if (!this._config.refreshToken) return;
      const newTokens = await refreshTokens(this._config.cognito, this._config.refreshToken);
      this._idToken = newTokens.idToken;
      this._config.onTokensRefreshed?.(newTokens);
    } catch {
      // If we can't refresh the ID token, proceed with the existing one and let
      // the Cognito call fail naturally.
    }
  }

  private _buildLogins(): Record<string, string> {
    const loginKey = `cognito-idp.${this._config.region}.amazonaws.com/${this._config.userPoolId}`;
    return { [loginKey]: this._idToken };
  }

  private async _send<T extends CognitoIdentityResponse>(
    operation: 'GetId' | 'GetCredentialsForIdentity',
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`https://cognito-identity.${this._config.region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityService.${operation}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new CredentialError(
        `Cognito Identity ${operation} failed (${String(response.status)}): ${message}`,
      );
    }
    return (await response.json()) as T;
  }
}

interface CognitoIdentityResponse {
  readonly IdentityId?: string;
  readonly Credentials?: {
    readonly AccessKeyId?: string;
    readonly SecretKey?: string;
    readonly SessionToken?: string;
    readonly Expiration?: number;
  };
}
