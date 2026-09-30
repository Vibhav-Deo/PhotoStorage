/**
 * Dedupe resolution.
 *
 * The property under test is Requirement 3.2 in both of its forms: the same bytes reached by two
 * different routes produce **one** asset and **two** source references. Real files at unrelated
 * paths supply the digests, so the test exercises the path an actual two-source migration takes
 * rather than asserting against a hardcoded hash.
 *
 * Also asserted, because it is the cheap half of `design.md` open question 7: a source whose
 * recorded digest changes is refused loudly. On Android that is what EXIF redaction looks like
 * from this layer, and the alternative — silently overwriting the digest — ends with the true
 * original deleted and every check having passed.
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { applyConnectionPragmas, migrate } from '../db/migrate.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import type { SqlDriver } from '../db/driver.ts';
import { hashFile } from '../hash/nodeHash.ts';
import { hashBytes, type ContentHash } from '../hash/contentHash.ts';
import {
  AssetKind,
  CapturedAtSource,
  HashState,
  LocalState,
  Platform,
  RemoteState,
} from '../states.ts';
import {
  AssetRowMissingError,
  ContentSizeConflictError,
  DedupeLedger,
  InvalidContentHashError,
  Sighting,
  SourceHashDivergenceError,
  bindDeviceSource,
  describeSource,
  deviceSourcesFor,
  markSourceUnreadable,
  resolveDedupe,
  sourceRefId,
  type DeviceSource,
  type TakeoutSource,
} from './dedupe.ts';

const NOW = 1_700_000_000_000;

function fixtureBytes(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = (state >>> 16) & 0xff;
  }
  return bytes;
}

function device(localId: string, platform: Platform = Platform.Ios): DeviceSource {
  return { kind: 'device', localId, platform };
}

function takeout(filePath: string): TakeoutSource {
  return { kind: 'takeout', path: filePath };
}

// ---------------------------------------------------------------------------
// Source reference identity
// ---------------------------------------------------------------------------

describe('sourceRefId', () => {
  it('separates the two source kinds and the two platforms', () => {
    expect(sourceRefId(device('ABC-1'))).not.toBe(sourceRefId(device('ABC-1', Platform.Android)));
    expect(sourceRefId(device('42'))).not.toBe(sourceRefId(takeout('42')));
  });

  it('is stable and injective over local ids and paths', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(sourceRefId(device(a))).toBe(sourceRefId(device(a)));
        if (a !== b) expect(sourceRefId(device(a))).not.toBe(sourceRefId(device(b)));
        if (a !== b) expect(sourceRefId(takeout(a))).not.toBe(sourceRefId(takeout(b)));
      }),
    );
  });

  it('describes a source in terms a user could act on', () => {
    expect(describeSource(device('ABC/L0/001'))).toContain('iOS');
    expect(describeSource(device('17', Platform.Android))).toContain('Android');
    expect(describeSource(takeout('Takeout/Google Photos/IMG_1.HEIC'))).toContain('IMG_1.HEIC');
  });
});

// ---------------------------------------------------------------------------
// The in-memory ledger, over real byte-identical fixtures
// ---------------------------------------------------------------------------

describe('DedupeLedger over byte-identical fixtures from different paths', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'photo-archive-dedupe-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(relative: string, bytes: Uint8Array): Promise<string> {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    return target;
  }

  it('yields one asset with two source references', async () => {
    // The same photo out of Google Takeout and off the phone. Different directories, different
    // filenames, same bytes — which is the ordinary case, not the corner case.
    const bytes = fixtureBytes(51_200, 5);
    const takeoutPath = 'Takeout/Google Photos/Photos from 2019/IMG_1234.HEIC';
    const takeoutFile = await write(takeoutPath, bytes);
    const deviceFile = await write('DCIM/100APPLE/IMG_1234.heic', bytes);

    const ledger = new DedupeLedger();
    const first = ledger.record(takeout(takeoutPath), await hashFile(takeoutFile));
    const second = ledger.record(device('ABC-1'), await hashFile(deviceFile));

    expect(first.sighting).toBe(Sighting.First);
    expect(second.sighting).toBe(Sighting.Duplicate);
    expect(second.hash).toBe(first.hash);

    // One piece of content, two places it was found.
    expect(ledger.contentCount).toBe(1);
    expect(ledger.sourceCount).toBe(2);
    expect(ledger.sourcesOf(first.hash)).toEqual([takeout(takeoutPath), device('ABC-1')]);
    expect(second.sources).toHaveLength(2);

    // And the saving the reconciliation report shows the user.
    expect(ledger.bytesSavedByDedupe).toBe(bytes.length);
  });

  it('keeps distinct content distinct', async () => {
    const a = await hashFile(await write('a.jpg', fixtureBytes(1000, 1)));
    const b = await hashFile(await write('b.jpg', fixtureBytes(1000, 2)));

    const ledger = new DedupeLedger();
    expect(ledger.record(takeout('a.jpg'), a).sighting).toBe(Sighting.First);
    expect(ledger.record(takeout('b.jpg'), b).sighting).toBe(Sighting.First);
    expect(ledger.contentCount).toBe(2);
    expect(ledger.bytesSavedByDedupe).toBe(0);
  });

  it('treats a re-run of the same source as a no-op', async () => {
    const content = await hashFile(await write('a.jpg', fixtureBytes(500)));
    const ledger = new DedupeLedger();
    ledger.record(takeout('a.jpg'), content);

    // Resuming an interrupted import re-offers work that already completed (Requirement 1.9).
    const again = ledger.record(takeout('a.jpg'), content);
    expect(again.sighting).toBe(Sighting.Repeat);
    expect(ledger.sourceCount).toBe(1);
    expect(ledger.bytesSavedByDedupe).toBe(0);
  });

  it('collapses many sources onto one asset, whatever order they arrive in', async () => {
    const bytes = fixtureBytes(4096, 9);
    const content = await hashBytes(bytes);

    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.string(), { minLength: 1, maxLength: 8 }), async (ids) => {
        const ledger = new DedupeLedger();
        for (const id of ids) ledger.record(device(id), content);

        expect(ledger.contentCount).toBe(1);
        expect(ledger.sourceCount).toBe(ids.length);
        expect(ledger.sourcesOf(content.hash)).toHaveLength(ids.length);
        expect(ledger.bytesSavedByDedupe).toBe((ids.length - 1) * bytes.length);
        await Promise.resolve();
      }),
      { numRuns: 50 },
    );
  });

  it('refuses a source whose digest changed between reads', async () => {
    const original = await hashBytes(fixtureBytes(2048, 1));
    // What redaction produces: the same MediaStore item yielding different bytes because the
    // location EXIF was stripped on one read and not the other.
    const redacted = await hashBytes(fixtureBytes(2048, 2));

    const ledger = new DedupeLedger();
    const source = device('17', Platform.Android);
    ledger.record(source, original);

    expect(() => ledger.record(source, redacted)).toThrow(SourceHashDivergenceError);
    try {
      ledger.record(source, redacted);
    } catch (error) {
      // The message has to name the suspect, or the next person debugging it starts from zero.
      expect((error as Error).message).toContain('ACCESS_MEDIA_LOCATION');
      expect(error).toMatchObject({ recorded: original.hash, observed: redacted.hash });
    }
  });

  it('refuses two byte counts under one digest', () => {
    const hash = 'a'.repeat(64);
    const ledger = new DedupeLedger();
    ledger.record(takeout('a.jpg'), { hash, byteSize: 100 });
    expect(() => ledger.record(takeout('b.jpg'), { hash, byteSize: 101 })).toThrow(
      ContentSizeConflictError,
    );
  });

  it('refuses anything that is not a lowercase hex digest', () => {
    const ledger = new DedupeLedger();
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '', 'not-a-hash']) {
      expect(() => ledger.record(takeout('a.jpg'), { hash: bad, byteSize: 1 })).toThrow(
        InvalidContentHashError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Durable resolution against SQLite
// ---------------------------------------------------------------------------

describe('device source binding', () => {
  let driver: NodeSqliteDriver;
  let content: ContentHash;

  beforeEach(async () => {
    driver = new NodeSqliteDriver();
    await applyConnectionPragmas(driver);
    await migrate(driver);
    content = await hashBytes(fixtureBytes(8192, 4));
  });

  afterEach(() => {
    driver.close();
  });

  async function insertAsset(db: SqlDriver, hash: string, byteSize: number): Promise<void> {
    await db.run(
      `INSERT INTO assets(hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash,
                          remote_state, local_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        AssetKind.Image,
        byteSize,
        'image/heic',
        NOW,
        CapturedAtSource.TakeoutJson,
        new Uint8Array([1, 2, 3]),
        RemoteState.LocalOnly,
        LocalState.Present,
        NOW,
      ],
    );
  }

  it('records two local ids against one asset row', async () => {
    await insertAsset(driver, content.hash, content.byteSize);

    const first = await bindDeviceSource(driver, device('ABC-1'), content, { now: NOW });
    const second = await bindDeviceSource(driver, device('ABC-2'), content, { now: NOW + 1 });

    expect(first.sighting).toBe(Sighting.First);
    expect(second.sighting).toBe(Sighting.Duplicate);

    // One asset, two source references — the schema's own "one hash may map to several local
    // ids" made real.
    const assets = await driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM assets');
    expect(Number(assets[0]?.n)).toBe(1);
    expect(await deviceSourcesFor(driver, content.hash)).toEqual([
      device('ABC-1'),
      device('ABC-2'),
    ]);
  });

  it('is idempotent, so a resumed ingest re-binds harmlessly', async () => {
    await insertAsset(driver, content.hash, content.byteSize);
    await bindDeviceSource(driver, device('ABC-1'), content, { now: NOW });
    const again = await bindDeviceSource(driver, device('ABC-1'), content, { now: NOW + 5000 });

    expect(again.sighting).toBe(Sighting.Repeat);
    const rows = await driver.all<{ hash_state: number; first_seen: number; last_seen: number }>(
      'SELECT hash_state, first_seen, last_seen FROM local_assets WHERE local_id = ?',
      ['ABC-1'],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.hash_state)).toBe(HashState.Done);
    // first_seen is when the library first showed it; last_seen moves.
    expect(Number(rows[0]?.first_seen)).toBe(NOW);
    expect(Number(rows[0]?.last_seen)).toBe(NOW + 5000);
  });

  it('refuses to overwrite a recorded digest with a different one', async () => {
    await insertAsset(driver, content.hash, content.byteSize);
    const other = await hashBytes(fixtureBytes(8192, 99));
    await insertAsset(driver, other.hash, other.byteSize);

    const source = device('17', Platform.Android);
    await bindDeviceSource(driver, source, content, { now: NOW });

    // The Android redaction tripwire. Silently accepting the second digest is how the true
    // original ends up deleted with every check having passed.
    await expect(bindDeviceSource(driver, source, other, { now: NOW })).rejects.toBeInstanceOf(
      SourceHashDivergenceError,
    );

    const rows = await driver.all<{ hash: string }>(
      'SELECT hash FROM local_assets WHERE local_id = ?',
      ['17'],
    );
    expect(rows[0]?.hash).toBe(content.hash);
  });

  it('releases the write lock when it refuses', async () => {
    await insertAsset(driver, content.hash, content.byteSize);
    const other = await hashBytes(fixtureBytes(8192, 99));
    await bindDeviceSource(driver, device('17'), content, { now: NOW });

    await expect(bindDeviceSource(driver, device('17'), other, { now: NOW })).rejects.toThrow();
    // A held transaction would make the next stage fail with SQLITE_BUSY and hide the real cause.
    await expect(
      bindDeviceSource(driver, device('ABC-2'), content, { now: NOW }),
    ).resolves.toMatchObject({ sighting: Sighting.Duplicate });
  });

  it('explains the stage ordering instead of raising a bare foreign key error', async () => {
    // assets.captured_at and assets.thumbhash are NOT NULL, so the asset row cannot exist until
    // ExtractMeta and Derive have run — which is after Hash. The digest travels in the job row
    // until then, and binding early is a sequencing bug worth naming.
    await expect(
      bindDeviceSource(driver, device('ABC-1'), content, { now: NOW }),
    ).rejects.toBeInstanceOf(AssetRowMissingError);
    expect(await deviceSourcesFor(driver, content.hash)).toEqual([]);
  });

  it('refuses a byte size that disagrees with the asset row', async () => {
    await insertAsset(driver, content.hash, content.byteSize + 1);
    await expect(
      bindDeviceSource(driver, device('ABC-1'), content, { now: NOW }),
    ).rejects.toBeInstanceOf(ContentSizeConflictError);
  });
});

describe('resolveDedupe', () => {
  let driver: NodeSqliteDriver;
  let content: ContentHash;

  beforeEach(async () => {
    driver = new NodeSqliteDriver();
    await applyConnectionPragmas(driver);
    await migrate(driver);
    content = await hashBytes(fixtureBytes(2048, 6));
  });

  afterEach(() => {
    driver.close();
  });

  async function insertAsset(hash: string, byteSize: number): Promise<void> {
    await driver.run(
      `INSERT INTO assets(hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash,
                          remote_state, local_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        AssetKind.Image,
        byteSize,
        'image/jpeg',
        NOW,
        CapturedAtSource.Exif,
        new Uint8Array([9]),
        RemoteState.Verified,
        LocalState.Present,
        NOW,
      ],
    );
  }

  it('reports new content, so the full pipeline runs', async () => {
    const decision = await resolveDedupe(driver, device('ABC-1'), content);
    expect(decision).toEqual({
      hash: content.hash,
      byteSize: content.byteSize,
      sighting: Sighting.First,
      assetExists: false,
      otherSources: [],
    });
  });

  it('reports a duplicate, so derive, embed, and upload can be skipped', async () => {
    await insertAsset(content.hash, content.byteSize);
    await bindDeviceSource(driver, device('ABC-1'), content, { now: NOW });

    const decision = await resolveDedupe(driver, device('ABC-2'), content);
    expect(decision.sighting).toBe(Sighting.Duplicate);
    expect(decision.assetExists).toBe(true);
    expect(decision.otherSources).toEqual([device('ABC-1')]);
  });

  it('reports a repeat for a source already bound, and does not list it as another', async () => {
    await insertAsset(content.hash, content.byteSize);
    await bindDeviceSource(driver, device('ABC-1'), content, { now: NOW });

    const decision = await resolveDedupe(driver, device('ABC-1'), content);
    expect(decision.sighting).toBe(Sighting.Repeat);
    expect(decision.otherSources).toEqual([]);
  });

  it('writes nothing', async () => {
    await resolveDedupe(driver, device('ABC-1'), content);
    const rows = await driver.all<{ n: number }>('SELECT COUNT(*) AS n FROM local_assets');
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('refuses a byte size that disagrees with the asset row', async () => {
    await insertAsset(content.hash, content.byteSize + 10);
    await expect(resolveDedupe(driver, device('ABC-1'), content)).rejects.toBeInstanceOf(
      ContentSizeConflictError,
    );
  });
});

describe('markSourceUnreadable', () => {
  let driver: NodeSqliteDriver;

  beforeEach(async () => {
    driver = new NodeSqliteDriver();
    await applyConnectionPragmas(driver);
    await migrate(driver);
  });

  afterEach(() => {
    driver.close();
  });

  it('records an original that could not be read, rather than skipping it', async () => {
    // Reached on Android below API 28 for HEIC, and for any corrupt file. An item that was never
    // hashed can never be verified and so can never become purge-eligible, so it has to be
    // visible in ingest status (Requirements 1.10, 2.7).
    await markSourceUnreadable(driver, device('17', Platform.Android), { now: NOW });

    const rows = await driver.all<{ hash: string | null; hash_state: number; platform: number }>(
      'SELECT hash, hash_state, platform FROM local_assets WHERE local_id = ?',
      ['17'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBeNull();
    expect(Number(rows[0]?.hash_state)).toBe(HashState.Unreadable);
    expect(Number(rows[0]?.platform)).toBe(Platform.Android);
  });

  it('is idempotent and keeps the row that enumeration created', async () => {
    await driver.run(
      `INSERT INTO local_assets(local_id, hash, platform, hash_state, first_seen, last_seen)
         VALUES (?, NULL, ?, ?, ?, ?)`,
      ['17', Platform.Android, HashState.Pending, NOW - 1000, NOW - 1000],
    );

    await markSourceUnreadable(driver, device('17', Platform.Android), { now: NOW });
    await markSourceUnreadable(driver, device('17', Platform.Android), { now: NOW + 1 });

    const rows = await driver.all<{ hash_state: number; first_seen: number; last_seen: number }>(
      'SELECT hash_state, first_seen, last_seen FROM local_assets WHERE local_id = ?',
      ['17'],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.hash_state)).toBe(HashState.Unreadable);
    expect(Number(rows[0]?.first_seen)).toBe(NOW - 1000);
    expect(Number(rows[0]?.last_seen)).toBe(NOW + 1);
  });
});
