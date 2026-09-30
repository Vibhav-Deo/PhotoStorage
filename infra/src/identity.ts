import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface IdentityStackProps extends cdk.StackProps {
  readonly bucket: s3.IBucket;
  /**
   * OAuth callback URLs for the hosted UI (e.g. `myapp://auth`).
   * Must include at least one entry for social sign-in to work.
   */
  readonly callbackUrls: readonly string[];
  readonly logoutUrls: readonly string[];
  /**
   * Google OAuth client credentials. Required to enable Google sign-in.
   * Store in Secrets Manager and pass the resolved values at synth time.
   */
  readonly googleClientId?: string;
  readonly googleClientSecret?: string;
  /**
   * Facebook app credentials. Required to enable Facebook sign-in.
   */
  readonly facebookAppId?: string;
  readonly facebookAppSecret?: string;
}

/**
 * Task 3.2 — Cognito User Pool + Identity Pool.
 *
 * Design decisions:
 * - User Pool on the Essentials tier. Social IdPs (Google/Apple/Facebook) count against the
 *   10,000 MAU allowance, not the 50 MAU federation allowance (design: Auth).
 * - Sign in with Apple is mandatory once Google or Facebook is offered (App Store Guideline 4.8).
 * - Identity Pool vends STS credentials. The authenticated role's IAM policy scopes S3 to
 *   `${cognito-identity.amazonaws.com:sub}/*` exactly — isolation is enforced by IAM, not by
 *   application code (Req 13.3).
 * - The unauthenticated role has no permissions. The app requires sign-in.
 */
export class IdentityStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly identityPool: cognito.CfnIdentityPool;
  readonly authenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    // ── User Pool ──────────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: 'photo-archive-860100076027' },
    });

    // Social providers — each is optional at synth time so the stack deploys
    // without credentials during development.
    const supportedIdentityProviders: cognito.UserPoolClientIdentityProvider[] = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];

    if (props.googleClientId && props.googleClientSecret) {
      new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
        userPool: this.userPool,
        clientId: props.googleClientId,
        clientSecretValue: cdk.SecretValue.unsafePlainText(props.googleClientSecret),
        scopes: ['email', 'profile', 'openid'],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
          familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
          profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
        },
      });
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
    }

    if (props.facebookAppId && props.facebookAppSecret) {
      new cognito.UserPoolIdentityProviderFacebook(this, 'Facebook', {
        userPool: this.userPool,
        clientId: props.facebookAppId,
        clientSecret: props.facebookAppSecret,
        scopes: ['email', 'public_profile'],
        attributeMapping: {
          email: cognito.ProviderAttribute.FACEBOOK_EMAIL,
        },
      });
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.FACEBOOK);
    }

    // Sign in with Apple is mandatory once another social provider is offered
    // (App Store Guideline 4.8). Do not register a placeholder provider: Cognito
    // rejects a client that references an Apple provider that was not created.
    const appleServicesId = this.node.tryGetContext('appleServicesId') as string | undefined;
    const appleTeamId = this.node.tryGetContext('appleTeamId') as string | undefined;
    const appleKeyId = this.node.tryGetContext('appleKeyId') as string | undefined;
    const applePrivateKey = this.node.tryGetContext('applePrivateKey') as string | undefined;

    if (appleServicesId && appleTeamId && appleKeyId && applePrivateKey) {
      new cognito.UserPoolIdentityProviderApple(this, 'Apple', {
        userPool: this.userPool,
        clientId: appleServicesId,
        teamId: appleTeamId,
        keyId: appleKeyId,
        privateKeyValue: cdk.SecretValue.unsafePlainText(applePrivateKey),
        scopes: ['email', 'name'],
        attributeMapping: {
          email: cognito.ProviderAttribute.APPLE_EMAIL,
        },
      });
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.APPLE);
    }

    // ── App client ─────────────────────────────────────────────────────────
    this.userPoolClient = this.userPool.addClient('MobileClient', {
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: [...props.callbackUrls],
        logoutUrls: [...props.logoutUrls],
      },
      supportedIdentityProviders,
      preventUserExistenceErrors: true,
    });

    // ── Identity Pool ──────────────────────────────────────────────────────
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
          serverSideTokenCheck: true,
        },
      ],
    });

    // ── IAM roles ──────────────────────────────────────────────────────────
    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Authenticated photo-archive user - scoped to own S3 prefix',
    });

    // The load-bearing policy: scopes every S3 action to the caller's own
    // Cognito identity sub. Isolation is enforced by IAM, not application code (Req 13.3).
    this.authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: [`${props.bucket.bucketArn}/\${cognito-identity.amazonaws.com:sub}/*`],
      }),
    );

    this.authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [props.bucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': '${cognito-identity.amazonaws.com:sub}/*',
          },
        },
      }),
    );

    const unauthenticatedRole = new iam.Role(this, 'UnauthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'unauthenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Unauthenticated role - no permissions (sign-in required)',
    });

    new cognito.CfnIdentityPoolRoleAttachment(this, 'RoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
        unauthenticated: unauthenticatedRole.roleArn,
      },
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: `https://photo-archive-860100076027.auth.${this.region}.amazoncognito.com`,
    });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref });
    new cdk.CfnOutput(this, 'AuthenticatedRoleArn', {
      value: this.authenticatedRole.roleArn,
    });
  }
}
