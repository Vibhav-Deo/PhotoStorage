/**
 * CoarseSlotLedger tests, against `node:sqlite` and the real schema so the
 * `vector_slots` SQL is exercised exactly as the device runs it.
 *
 * The load-bearing assertions are the ordering ones (task 6.2):
 * - a fresh assign writes the vector before the row, and frees the slot if the
 *   row insert fails — a partial write can never strand a live-looking slot;
 * - release deletes the row before freeing the slot — a crash between the two
 *   leaves a slot that stays allocated rather than one search could resurrect.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConnectionPragmas, migrate } from '../db/migrate.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { COARSE_VECTOR_DIM } from './embedding.ts';
import { CoarseIndex, InMemoryCoarseStore } from './coarseIndex.ts';
import { CoarseSlotLedger, CoarseSlotLedgerError } from './slotLedger.ts';

/** Distinct valid 64-hex content hashes. */
function hash(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** `vector_slots.hash` references `assets(hash)`; the embed pipeline only ever
 *  assigns slots for ingested assets, so the tests seed the parent rows. */
async function seedAsset(d: NodeSqliteDriver, h: string): Promise<void> {
  await d.run(
    `INSERT INTO assets(hash, kind, byte_size, mime, captured_at, captured_at_src,
                        thumbhash, remote_state, local_state, updated_at)
     VALUES(?, 0, 1, 'image/jpeg', 0, 0, ?, 2, 1, 0)`,
    [h, new Uint8Array([0])],
  );
}

function testVector(seed: number): Int8Array {
  const v = new Int8Array(COARSE_VECTOR_DIM);
  for (let i = 0; i < COARSE_VECTOR_DIM; i++) v[i] = ((seed * 31 + i * 17) % 251) - 125;
  return v;
}

describe('CoarseSlotLedger (task 6.2)', () => {
  let tmpDir: string;
  let driver: NodeSqliteDriver;
  let store: InMemoryCoarseStore;
  let index: CoarseIndex;
  let ledger: CoarseSlotLedger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-slotledger-'));
    driver = new NodeSqliteDriver({ path: path.join(tmpDir, 'test.db') });
    await applyConnectionPragmas(driver);
    await migrate(driver);
    store = new InMemoryCoarseStore();
    index = await CoarseIndex.open(store, store);
    ledger = new CoarseSlotLedger(driver, index);
    // Seed the asset rows the tests' vector_slots rows will reference.
    for (const n of [1, 2, 3, 7, 99, 300, 404]) {
      await seedAsset(driver, hash(n));
    }
  });

  afterEach(async () => {
    driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('assigns sequential slots and records vector_slots rows', async () => {
    const a = await ledger.assign(hash(1), testVector(1));
    const b = await ledger.assign(hash(2), testVector(2));
    expect(a).toBe(0);
    expect(b).toBe(1);

    const rows = await driver.all<{ hash: string; slot: number; model_id: string }>(
      'SELECT hash, slot, model_id FROM vector_slots ORDER BY slot',
    );
    expect(rows).toEqual([
      { hash: hash(1), slot: 0, model_id: index.modelId },
      { hash: hash(2), slot: 1, model_id: index.modelId },
    ]);
    expect(await ledger.slotFor(hash(1))).toBe(0);
    expect(await ledger.hashAt(1)).toBe(hash(2));
    expect(await ledger.hashAt(99)).toBeNull();
  });

  it('round-trips the vector through the index', async () => {
    const slot = await ledger.assign(hash(7), testVector(7));
    expect([...(await index.readVector(slot))]).toEqual([...testVector(7)]);
  });

  it('is idempotent per hash: re-assign overwrites the same slot', async () => {
    const first = await ledger.assign(hash(3), testVector(3));
    const second = await ledger.assign(hash(3), testVector(300));
    expect(second).toBe(first);
    expect([...(await index.readVector(first))]).toEqual([...testVector(300)]);
    const rows = await driver.all('SELECT slot, hash FROM vector_slots');
    expect(rows).toHaveLength(1);
  });

  it('release frees the slot and removes the row; a later assign reuses the slot', async () => {
    const a = await ledger.assign(hash(1), testVector(1));
    await ledger.assign(hash(2), testVector(2));
    await ledger.release(hash(1));
    expect(await ledger.slotFor(hash(1))).toBeNull();
    expect(index.freeSlots).toEqual([a]);

    const c = await ledger.assign(hash(3), testVector(3));
    expect(c).toBe(a); // reused
    expect(index.freeSlots).toEqual([]);
  });

  it('release is idempotent for unknown hashes', async () => {
    await expect(ledger.release(hash(404))).resolves.toBeUndefined();
  });

  it('a failed row insert frees the slot again (compensation ordering)', async () => {
    // Pre-claim the slot the next allocation will hand out (slot 0) so the
    // INSERT hits the slot primary key. The ledger must free slot 0 and throw.
    await driver.run('INSERT INTO vector_slots(slot, hash, model_id) VALUES(?, ?, ?)', [
      0,
      hash(99),
      index.modelId,
    ]);
    await expect(ledger.assign(hash(1), testVector(1))).rejects.toThrow(CoarseSlotLedgerError);
    expect(index.freeSlots).toEqual([0]);
    // Clear the pre-claim; the next assign must reuse the compensated slot.
    await driver.run('DELETE FROM vector_slots WHERE hash = ?', [hash(99)]);
    const next = await ledger.assign(hash(1), testVector(1));
    expect(next).toBe(0);
    expect(index.freeSlots).toEqual([]);
  });

  it('rejects non-content hashes rather than writing junk rows', async () => {
    await expect(ledger.assign('not-a-hash', testVector(1))).rejects.toThrow(CoarseSlotLedgerError);
    const rows = await driver.all('SELECT * FROM vector_slots');
    expect(rows).toHaveLength(0);
    expect(index.slotCount).toBe(0);
  });
});
