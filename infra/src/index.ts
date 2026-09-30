/**
 * CDK app entry point.
 *
 * Stacks:
 *   StorageStack  (3.1) — S3 bucket with Intelligent-Tiering, CORS
 *   IdentityStack (3.2) — Cognito User Pool + Identity Pool, IAM scoped to {sub}/*
 *   MetadataStack (3.3) — DynamoDB change log, LSI on version defined at creation
 *   SyncStack     (3.4) — Lambda Function URL, JWT verification, delta pull/push
 *
 * Context keys (pass via `cdk deploy --context key=value` or cdk.json):
 *   appleServicesId   — Apple Sign In Services ID
 *   appleTeamId       — Apple Developer Team ID
 *   appleKeyId        — Apple Sign In key ID
 *   applePrivateKey   — Apple Sign In private key (PEM, single line)
 *   googleClientId    — Google OAuth client ID
 *   googleClientSecret — Google OAuth client secret
 *   facebookAppId     — Facebook app ID
 *   facebookAppSecret — Facebook app secret
 *   callbackUrls      — comma-separated OAuth callback URLs
 *   logoutUrls        — comma-separated OAuth logout URLs
 */

import * as cdk from 'aws-cdk-lib';
import type { IdentityStackProps } from './identity.ts';
import { IdentityStack } from './identity.ts';
import { MetadataStack } from './metadata.ts';
import { StorageStack } from './storage.ts';
import { SyncStack } from './sync.ts';

const app = new cdk.App();

const account = process.env['CDK_DEFAULT_ACCOUNT'];
const env: cdk.Environment =
  account !== undefined
    ? { account, region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1' }
    : { region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1' };

const storage = new StorageStack(app, 'PhotoArchiveStorage', { env });

const googleClientId = app.node.tryGetContext('googleClientId') as string | undefined;
const googleClientSecret = app.node.tryGetContext('googleClientSecret') as string | undefined;
const facebookAppId = app.node.tryGetContext('facebookAppId') as string | undefined;
const facebookAppSecret = app.node.tryGetContext('facebookAppSecret') as string | undefined;

const identityProps: IdentityStackProps = {
  env,
  bucket: storage.bucket,
  callbackUrls: (
    (app.node.tryGetContext('callbackUrls') as string | undefined) ??
    'myapp://auth,http://localhost:3000/'
  )
    .split(',')
    .map((s) => s.trim()),
  logoutUrls: (
    (app.node.tryGetContext('logoutUrls') as string | undefined) ??
    'myapp://logout,http://localhost:3000/'
  )
    .split(',')
    .map((s) => s.trim()),
  ...(googleClientId !== undefined ? { googleClientId } : {}),
  ...(googleClientSecret !== undefined ? { googleClientSecret } : {}),
  ...(facebookAppId !== undefined ? { facebookAppId } : {}),
  ...(facebookAppSecret !== undefined ? { facebookAppSecret } : {}),
};

const identity = new IdentityStack(app, 'PhotoArchiveIdentity', identityProps);

const metadata = new MetadataStack(app, 'PhotoArchiveMetadata', { env });

new SyncStack(app, 'PhotoArchiveSync', {
  env,
  table: metadata.table,
  userPool: identity.userPool,
});
