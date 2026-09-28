import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Construct } from 'constructs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface SyncStackProps extends cdk.StackProps {
  readonly table: dynamodb.Table;
  readonly userPool: cognito.IUserPool;
}

/**
 * Task 3.4 — Sync Lambda with Function URL.
 *
 * Design decisions:
 * - Function URL (no API Gateway needed). Sync relay and entitlement only (design: Backend).
 * - JWT verification against the User Pool JWKS inside the handler — no Lambda authorizer,
 *   because the handler must also enforce the partition key check (Req 13.3).
 * - Atomic version counter via DynamoDB ADD on `META#counter` (design: DynamoDB change log).
 * - Delta pull uses LSI1-version; delta push uses TransactWriteItems (max 25 per batch).
 * - The function has no VPC, no provisioned concurrency — scales to zero (Req 9.4).
 * - Node 22.x runtime matches the repo's engine requirement.
 */
export class SyncStack extends cdk.Stack {
  readonly syncFunction: lambda.Function;
  readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: SyncStackProps) {
    super(scope, id, props);

    this.syncFunction = new lambda.Function(this, 'SyncFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'syncHandler.handler',
      // The handler is compiled to dist/ by `tsc --build` before CDK deploy.
      code: lambda.Code.fromAsset(path.join(HERE, '../../dist')),
      environment: {
        TABLE_NAME: props.table.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        NODE_OPTIONS: '--enable-source-maps',
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant the function read/write access to the change log table.
    props.table.grantReadWriteData(this.syncFunction);

    // The function also needs to query the LSI, which grantReadWriteData covers
    // because it grants dynamodb:Query on the table ARN and all its indexes.

    // Explicit deny: the function must never touch S3. Metadata only (Req 13.5).
    this.syncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['s3:*'],
        resources: ['*'],
      }),
    );

    // Function URL — CORS open so the mobile client can call it directly.
    this.functionUrl = this.syncFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Auth is JWT inside the handler.
      cors: {
        allowedOrigins: ['*'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        maxAge: cdk.Duration.hours(1),
      },
    });

    new cdk.CfnOutput(this, 'SyncFunctionUrl', { value: this.functionUrl.url });
    new cdk.CfnOutput(this, 'SyncFunctionArn', {
      value: this.syncFunction.functionArn,
    });
  }
}
