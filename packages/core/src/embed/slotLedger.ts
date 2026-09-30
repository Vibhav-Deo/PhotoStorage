/**
 * Pairs the coarse index with the `vector_slots` table, task 6.2.
 *
 * The design keeps slot→hash mapping in SQLite (`vector_slots`) and the packed
 * vectors in `coarse.bin` + its header sidecar. The two stores must agree: a
 * slot with a DB row must not be on the index free-list, and a released asset's
 * row must go before its slot is freed. This ledger is the one place that owns
 * that ordering, so the embed pipeline (Phase 7) and the model-version
 * migration (task 6.8) cannot get it independently wrong.
 *
 * Lives in core rather than the app because it is built entirely from core
 * seams (`SqlDriver` + `CoarseIndex`), which also makes it testable against
 * `node:sqlite` in this repo's normal test run.
 */

import { isContentHash } from '../keys.ts';
import type { SqlDriver } from '../db/driver.ts';
import type { CoarseIndex } from './coarseIndex.ts';

export class CoarseSlotLedgerError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CoarseSlotLedgerError';
    this.cause = cause;
  }
}

type SlotRow = { slot: number };

type HashRow = { hash: string };

/**
 * Assigns, rewrites, and releases coarse slots, keeping `vector_slots` and the
 * index header consistent. One instance per index; not safe to share across
 * processes, exactly like the SQLite database itself.
 */
export class CoarseSlotLedger {
  private readonly driver: SqlDriver;
  private readonly index: CoarseIndex;

  constructor(driver: SqlDriver, index: CoarseIndex) {
    this.driver = driver;
    this.index = index;
  }

  /**
   * Records `hash`'s vector and returns its slot.
   *
   * Idempotent per hash: re-embedding an asset that already has a slot
   * overwrites the vector in place and keeps the slot — this is what makes
   * incremental re-embedding (task 6.8) cheap.
   *
   * Ordering on a fresh assignment: allocate → write bytes → insert the row.
   * If the insert fails (unique violation, driver error), the slot is freed
   * again so the free-list survives a partial write; stale bytes in a freed
   * slot are skipped by `scanSlots`.
   */
  async assign(hash: string, vector: Int8Array): Promise<number> {
    if (!isContentHash(hash)) {
      throw new CoarseSlotLedgerError(
        `'${hash.slice(0, 12)}…' is not a content hash; vector_slots references assets(hash)`,
      );
    }

    const existing = await this.driver.get<SlotRow>(
      'SELECT slot FROM vector_slots WHERE hash = ?',
      [hash],
    );
    if (existing) {
      // Re-embed: same content, same slot, new vector.
      await this.index.writeVector(existing.slot, vector);
      return existing.slot;
    }

    const slot = await this.index.allocate();
    await this.index.writeVector(slot, vector);
    try {
      await this.driver.run('INSERT INTO vector_slots(slot, hash, model_id) VALUES(?, ?, ?)', [
        slot,
        hash,
        this.index.modelId,
      ]);
    } catch (err) {
      // Compensate: the slot has no DB row, so return it to the free-list.
      await this.index.free(slot).catch((freeErr: unknown) => {
        throw new CoarseSlotLedgerError(
          `Slot ${String(slot)} was allocated for '${hash.slice(0, 12)}…' but could not be ` +
            `freed after a failed insert; the index header and vector_slots now disagree`,
          freeErr,
        );
      });
      throw new CoarseSlotLedgerError(
        `Failed to record the vector_slots row for '${hash.slice(0, 12)}…'`,
        err,
      );
    }
    return slot;
  }

  /**
   * Drops `hash`'s slot row and frees its slot. Idempotent: releasing a hash
   * with no row is a no-op, so tombstone replay and a locally-deleted asset
   * can both call it without ordering coordination.
   */
  async release(hash: string): Promise<void> {
    const row = await this.driver.get<SlotRow>('SELECT slot FROM vector_slots WHERE hash = ?', [
      hash,
    ]);
    if (!row) return;
    // Row first, then free: a crash between the two leaves a slot that stays
    // allocated rather than a free slot that search might resurrect.
    await this.driver.run('DELETE FROM vector_slots WHERE hash = ?', [hash]);
    await this.index.free(row.slot);
  }

  /** The slot holding `hash`'s vector, or null when the hash is not embedded. */
  async slotFor(hash: string): Promise<number | null> {
    const row = await this.driver.get<SlotRow>('SELECT slot FROM vector_slots WHERE hash = ?', [
      hash,
    ]);
    return row ? row.slot : null;
  }

  /** The hash occupying `slot`, or null when no row claims it. */
  async hashAt(slot: number): Promise<string | null> {
    const row = await this.driver.get<HashRow>('SELECT hash FROM vector_slots WHERE slot = ?', [
      slot,
    ]);
    return row ? row.hash : null;
  }
}
