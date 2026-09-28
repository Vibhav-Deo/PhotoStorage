import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

/**
 * Task 3.3 — DynamoDB metadata change log.
 *
 * Design decisions:
 * - Single table, on-demand capacity. Scales to zero; 25 GB perpetually free (design: DynamoDB).
 * - PK: `U#{sub}` — one partition per user.
 * - SK: `A#{hash}` for assets, `ALB#{id}` for albums, `META#counter` for the version counter.
 * - **LSI1 on `version` (Number) defined at creation** — an LSI cannot be added after table
 *   creation, and this is the index that makes delta pulls cheap (design: DynamoDB change log).
 * - Nothing large goes in DynamoDB: no vectors, no thumbhashes, no OCR text (Req 12.6).
 *   Those live on the device and in the bucket.
 * - Tombstones are retained indefinitely rather than hard-deleted (design: DynamoDB).
 * - LSI partitions are capped at 10 GB. At 500k assets × ~400 bytes the projection is ~200 MB,
 *   well within the limit.
 */
export class MetadataStack extends cdk.Stack {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'ChangeLog', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // U#{sub}
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // A#{hash} | ALB#{id} | META#counter
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Tombstones are retained indefinitely — no TTL.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      tableClass: dynamodb.TableClass.STANDARD,
    });

    // LSI1: ordered delta pulls by version number.
    // CRITICAL: defined at table creation — cannot be added later.
    // Delta pull query: PK = U#{sub} AND version > :cursor, ScanIndexForward = true, Limit = 500
    this.table.addLocalSecondaryIndex({
      indexName: 'LSI1-version',
      sortKey: { name: 'version', type: dynamodb.AttributeType.NUMBER },
      // ALL projection so a delta pull returns the full record without a second read.
      projectionType: dynamodb.ProjectionType.ALL,
    });

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'TableArn', { value: this.table.tableArn });
  }
}
