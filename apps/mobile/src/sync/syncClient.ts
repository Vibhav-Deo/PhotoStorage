/**
 * `MetadataSync` implementation for the mobile app.
 *
 * Calls the sync Lambda Function URL for delta pull and push. Applies pulled
 * records to local SQLite via `applyAssetRecords` / `applyAlbumRecords` from
 * `@photo-archive/core` (last-writer-wins, tombstones win).
 *
 * The sync cursor is persisted in `sync_state` so a restart resumes from the
 * last successful pull rather than re-applying the full change log.
 *
 * Requirements: 8.1, 8.3, 8.4
 */

import { applyAlbumRecords, applyAssetRecords, collectPendingAssets } from '@photo-archive/core';
import type { AlbumRecord, AssetRecord, SqlDriver } from '@photo-archive/core';
import type { CredentialProvider } from '../credentials/credentialProvider.ts';

export interface SyncClientConfig {
  /** Lambda Function URL, e.g. "https://xxxxxxxx.lambda-url.us-east-1.on.aws/" */
  readonly lambdaUrl: string;
}

export class SyncError extends Error {
  override readonly cause?: unknown;
  readonly statusCode: number | undefined;

  constructor(message: string, options?: { cause?: unknown; statusCode?: number }) {
    super(message);
    this.name = 'SyncError';
    this.cause = options?.cause;
    this.statusCode = options?.statusCode;
  }
}

const PULL_LIMIT = 500;
const PUSH_LIMIT = 25;
const CURSOR_KEY = 'sync_cursor';

async function readCursor(driver: SqlDriver): Promise<number> {
  const row = await driver.get<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [
    CURSOR_KEY,
  ]);
  return row ? Number(row.value) : 0;
}

async function writeCursor(driver: SqlDriver, cursor: number): Promise<void> {
  await driver.run(
    'INSERT INTO sync_state(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [CURSOR_KEY, String(cursor)],
  );
}

async function callLambda(
  lambdaUrl: string,
  idToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(lambdaUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new SyncError(`Sync Lambda returned ${String(response.status)}: ${text}`, {
      statusCode: response.status,
    });
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Pulls all pending records from the change log since the last cursor and applies
 * them to the local database. Returns the new cursor.
 */
export async function pullSync(
  driver: SqlDriver,
  config: SyncClientConfig,
  credentialProvider: CredentialProvider,
): Promise<number> {
  const creds = await credentialProvider.credentials();
  // Use the ID token from the credential provider's cached session.
  // We need the ID token for the Lambda's JWT verification — STS credentials
  // are for S3, not for the Lambda URL.
  const idToken = await getIdToken(credentialProvider);

  let cursor = await readCursor(driver);

  for (;;) {
    const response = await callLambda(config.lambdaUrl, idToken, {
      action: 'pull',
      cursor,
      limit: PULL_LIMIT,
    });

    const records = response['records'];
    const nextCursor = response['cursor'];

    if (!Array.isArray(records) || typeof nextCursor !== 'number') {
      throw new SyncError('Unexpected pull response shape');
    }

    if (records.length === 0) break;

    const assets = records.filter(isAssetRecord);
    const albums = records.filter(isAlbumRecord);

    if (assets.length > 0) await applyAssetRecords(driver, assets);
    if (albums.length > 0) await applyAlbumRecords(driver, albums);

    cursor = nextCursor;
    await writeCursor(driver, cursor);

    if (records.length < PULL_LIMIT) break;
  }

  // Suppress unused variable warning — creds is obtained to trigger refresh before pull.
  void creds;
  return cursor;
}

/**
 * Pushes locally-created records (version = 0) to the change log in batches of 25.
 * Returns the final cursor assigned by the server.
 */
export async function pushSync(
  driver: SqlDriver,
  config: SyncClientConfig,
  credentialProvider: CredentialProvider,
): Promise<number> {
  const idToken = await getIdToken(credentialProvider);
  let lastCursor = await readCursor(driver);

  for (;;) {
    const pending = await collectPendingAssets(driver, PUSH_LIMIT);
    if (pending.length === 0) break;

    const response = await callLambda(config.lambdaUrl, idToken, {
      action: 'push',
      records: pending.map(assetToRecord),
    });

    const cursor = response['cursor'];
    if (typeof cursor !== 'number') throw new SyncError('Unexpected push response shape');

    // Mark pushed records with the server-assigned version.
    for (const asset of pending) {
      await driver.run('UPDATE assets SET version = ? WHERE hash = ?', [cursor, asset.hash]);
    }

    lastCursor = cursor;
    await writeCursor(driver, lastCursor);
  }

  return lastCursor;
}

// ── Type guards ───────────────────────────────────────────────────────────

function isAssetRecord(r: unknown): r is AssetRecord {
  return typeof r === 'object' && r !== null && 'hash' in r && 'kind' in r && 'byteSize' in r;
}

function isAlbumRecord(r: unknown): r is AlbumRecord {
  return typeof r === 'object' && r !== null && 'id' in r && 'title' in r && !('hash' in r);
}

function assetToRecord(a: AssetRecord): Record<string, unknown> {
  return {
    pk: `U#${a.hash}`, // placeholder — server enforces the real partition key
    sk: `A#${a.hash}`,
    hash: a.hash,
    kind: a.kind,
    byteSize: a.byteSize,
    mime: a.mime,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    capturedAt: a.capturedAt,
    capturedAtSource: a.capturedAtSource,
    tzOffsetMin: a.tzOffsetMin,
    lat: a.lat,
    lon: a.lon,
    cameraMake: a.cameraMake,
    cameraModel: a.cameraModel,
    orientation: a.orientation,
    livePairHash: a.livePairHash,
    variantOfHash: a.variantOfHash,
    favorite: a.favorite,
    deletedAt: a.deletedAt,
    remoteState: a.remoteState,
    localState: a.localState,
    tierState: a.tierState,
    derivativeMask: a.derivativeMask,
    updatedAt: a.updatedAt,
    version: a.version,
  };
}

/**
 * Extracts the ID token from the credential provider's cached session.
 * The CredentialProvider holds the ID token internally; we expose it via a
 * narrow accessor rather than storing it separately.
 */
async function getIdToken(credentialProvider: CredentialProvider): Promise<string> {
  // CredentialProvider doesn't expose the ID token directly — we call credentials()
  // to trigger any necessary refresh, then read the token from the provider's
  // internal state via a cast. In a future refactor, CredentialProvider should
  // expose `idToken(): Promise<string>` as a first-class method.
  //
  // For now, we trigger the refresh cycle and rely on the fact that the Lambda
  // accepts the same ID token that was used to obtain the STS credentials.
  await credentialProvider.credentials().catch(() => {
    // Read-only-local mode — sync will fail at the fetch call, which is correct.
  });

  // Access the private field via a type assertion. This is intentional and
  // documented: task 4.5 notes that CredentialProvider should expose idToken()
  // as a first-class method in a follow-up.
  const provider = credentialProvider as unknown as { _idToken: string };
  return provider._idToken;
}
