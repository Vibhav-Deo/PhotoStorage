/**
 * Task 3.5 — S3ObjectStore conformance suite.
 * Task 3.6 — IAM isolation test.
 *
 * Both tests require real AWS credentials and a bucket. They are skipped when
 * S3_TEST_BUCKET is not set, so CI passes without AWS access.
 *
 * To run against a real bucket:
 *   S3_TEST_BUCKET=my-bucket \
 *   S3_TEST_PREFIX=test-sub/ \
 *   S3_TEST_OTHER_PREFIX=other-sub/ \
 *   AWS_REGION=us-east-1 \
 *   npm test -- s3ObjectStore
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { runObjectStoreConformance } from './conformance.ts';
import { S3ObjectStore } from './s3ObjectStore.ts';

const BUCKET = process.env['S3_TEST_BUCKET'];
const PREFIX = process.env['S3_TEST_PREFIX'] ?? 'conformance/';
const OTHER_PREFIX = process.env['S3_TEST_OTHER_PREFIX'];
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

// ── Task 3.5: conformance suite ───────────────────────────────────────────
// Only register the suite when a real bucket is available. The factory must
// not run at collection time without credentials — it would make real S3 calls.

if (BUCKET !== undefined) {
  runObjectStoreConformance({
    name: `S3ObjectStore (${BUCKET})`,
    create: () => ({
      store: new S3ObjectStore({
        bucket: BUCKET,
        clientConfig: { region: REGION },
        keyPrefix: PREFIX,
      }),
    }),
    keyPrefix: PREFIX.replace(/\/$/, ''),
    includeMinimumPartSize: process.env['S3_TEST_FULL'] === '1',
  });
}

// Placeholder so Vitest sees at least one test in this file when S3 is absent.
describe.skipIf(BUCKET !== undefined)('S3ObjectStore (skipped — set S3_TEST_BUCKET to run)', () => {
  it('skipped', () => {
    /* intentionally empty */
  });
});

// ── Task 3.6: IAM isolation ───────────────────────────────────────────────

describe.skipIf(BUCKET === undefined || OTHER_PREFIX === undefined)(
  'IAM isolation: cross-prefix access is denied (task 3.6)',
  () => {
    it('AccessDenied when credentials scoped to one sub request a key under another', async () => {
      const ownClient = new S3Client({ region: REGION });
      const ownKey = `${PREFIX}isolation-probe-${Date.now().toString(36)}`;

      await ownClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: ownKey,
          Body: new Uint8Array([1, 2, 3]),
        }),
      );

      const crossKey = `${OTHER_PREFIX}isolation-probe`;
      await expect(
        ownClient.send(new GetObjectCommand({ Bucket: BUCKET, Key: crossKey })),
      ).rejects.toMatchObject({ name: 'AccessDenied' });
    });
  },
);
