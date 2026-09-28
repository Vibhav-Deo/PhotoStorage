import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  /** Bucket name. If omitted CDK generates one. */
  readonly bucketName?: string;
}

/**
 * Task 3.1 — S3 bucket with Intelligent-Tiering.
 *
 * Design decisions encoded here:
 * - Intelligent-Tiering on the originals prefix (`{sub}/orig/`). Derivatives stay in STANDARD
 *   because objects under 128 KB are never auto-tiered anyway (design: S3 key layout).
 * - Versioning disabled. The design explicitly says "versioning off for derivative prefixes"
 *   and originals are content-addressed so a second write of the same key is the same bytes.
 * - Public access blocked. Clients use STS credentials scoped by IAM (Req 13.3).
 * - CORS for the mobile client: PUT/GET/HEAD/DELETE from any origin (the app uses SigV4, not
 *   cookies, so the origin restriction adds nothing and breaks React Native's fetch).
 * - Lifecycle rule: abort incomplete multipart uploads after 7 days to avoid orphaned parts.
 */
export class StorageStack extends cdk.Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps = {}) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'PhotoArchiveBucket', {
      ...(props.bucketName !== undefined ? { bucketName: props.bucketName } : {}),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      // Abort incomplete multipart uploads — orphaned parts accumulate silently otherwise.
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      // Intelligent-Tiering configuration for the originals prefix.
      // Derivatives are STANDARD and never reach the tiering threshold (< 128 KB).
      intelligentTieringConfigurations: [
        {
          name: 'OriginalsIT',
          prefix: 'orig/',
          archiveAccessTierTime: cdk.Duration.days(90),
          deepArchiveAccessTierTime: cdk.Duration.days(180),
        },
      ],
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
            s3.HttpMethods.DELETE,
          ],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          // Expose ETag and checksum headers so the client can verify uploads.
          exposedHeaders: ['ETag', 'x-amz-checksum-sha256'],
          maxAge: 3600,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'BucketArn', { value: this.bucket.bucketArn });
  }
}
