/**
 * The file-backed coarse vector index (`coarse.bin`), task 6.2.
 *
 * The design's layout: `int8[slot][coarseDim]`, byte offset = slot × 256, with a
 * separate sidecar JSON header (`{ modelId, coarseDim, slotCount, freeSlots[] }`).
 * At reference scale (~6k slots, 1.5 MB) the buffer is small enough to read
 * eagerly; at 500k slots (128 MB) it must be read incrementally in chunks — the
 * scan is streaming and does not require full residency (Req 12.5).
 *
 * File I/O is platform-specific (`expo-file-system` on the device), so the
 * index is defined against two narrow seams — `CoarseStore` for the packed
 * bytes and `CoarseHeaderStore` for the sidecar JSON — following the same
 * pattern as `ObjectStore` and `SqlDriver`: the caller depends on the seam and
 * the platform picks the implementation. This module is pure JavaScript with no
 * Node built-ins, so it is safe for the root export Metro bundles.
 *
 * Durability: the header is persisted on every `allocate`/`free` mutation, so
 * process death mid-embedding loses at most the bytes of one unwritten vector,
 * never the free-list. A freed slot keeps its stale bytes — those are skipped
 * by `scanSlots`, which consults the free-list — so a slot can only become
 * visible to search after it is written and the caller records its hash.
 */

import { COARSE_VECTOR_DIM, DEFAULT_MODEL_ID, EmbeddingError } from './embedding.ts';
import type { CoarseVectorHeader } from './embedding.ts';

/** Default chunk size for `scanSlots`: 16384 slots ≈ 4 MB. */
export const DEFAULT_SCAN_CHUNK_SLOTS = 16384;

/**
 * Random-access byte store for the packed coarse vectors.
 *
 * `read` must return exactly `length` bytes and reject when the range is out of
 * bounds. `write` must handle growth: writing at `offset >= size()` extends
 * the store, zero-padding any gap (the in-memory and expo implementations both
 * do; a new slot's first write lands at the old end of the buffer).
 */
export interface CoarseStore {
  read(offset: number, length: number): Promise<Uint8Array>;
  write(offset: number, data: Uint8Array): Promise<void>;
  size(): Promise<number>;
}

/** Sidecar JSON header store. `readHeader` returns null when absent. */
export interface CoarseHeaderStore {
  readHeader(): Promise<string | null>;
  writeHeader(json: string): Promise<void>;
}

/** One slot's vector as yielded by `scanSlots`. */
export interface CoarseSlotVector {
  readonly slot: number;
  readonly vector: Int8Array;
}

export class CoarseIndexError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CoarseIndexError';
    this.cause = cause;
  }
}

export interface CoarseIndexOptions {
  /**
   * Expected model identity. When provided, a stored header with a different
   * `modelId` is an error rather than a silent read of foreign vectors —
   * model-version migration (task 6.8) is the only legitimate handler for a
   * mismatch, and it wants to see this error.
   */
  readonly modelId?: string;
  /** Slots per `scanSlots` read. Defaults to {@link DEFAULT_SCAN_CHUNK_SLOTS}. */
  readonly chunkSlots?: number;
  /**
   * When no header exists but the buffer holds bytes, adopt them as live
   * slots (`slotCount = size / coarseDim`, empty free-list). This exists for
   * buffers restored from the vector backup (task 4.6), which concatenate
   * shard bytes without a header. The byte count must divide evenly.
   */
  readonly adoptHeaderless?: boolean;
}

function parseIntStrict(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CoarseIndexError(`Header field '${field}' must be an integer`);
  }
  return value;
}

/** Validates a parsed header against the invariants the rest of this module relies on. */
function validateHeader(header: CoarseVectorHeader, options: CoarseIndexOptions): void {
  if (header.coarseDim !== COARSE_VECTOR_DIM) {
    throw new CoarseIndexError(
      `Header coarseDim ${String(header.coarseDim)} does not match this build's ` +
        `${String(COARSE_VECTOR_DIM)} — the buffer belongs to another model or is corrupt`,
    );
  }
  const expectedModel = options.modelId ?? DEFAULT_MODEL_ID;
  if (header.modelId !== expectedModel) {
    throw new CoarseIndexError(
      `Header modelId '${header.modelId}' does not match the expected '${expectedModel}'`,
    );
  }
  const slotCount = header.slotCount;
  if (!Number.isInteger(slotCount) || slotCount < 0) {
    throw new CoarseIndexError(
      `Header slotCount ${String(slotCount)} is not a non-negative integer`,
    );
  }
  const seen = new Set<number>();
  for (const slot of header.freeSlots) {
    const value = parseIntStrict(slot, 'freeSlots[]');
    if (value < 0 || value >= slotCount) {
      throw new CoarseIndexError(
        `Free slot ${String(value)} is outside the allocated range [0, ${String(slotCount)})`,
      );
    }
    if (seen.has(value)) {
      throw new CoarseIndexError(`Free slot ${String(value)} appears more than once`);
    }
    seen.add(value);
  }
}

/**
 * The file-backed coarse index. One instance owns one buffer; callers keep it
 * for the app's lifetime and coordinate `vector_slots` rows through
 * `CoarseSlotLedger`.
 */
export class CoarseIndex {
  readonly modelId: string;
  readonly coarseDim = COARSE_VECTOR_DIM;

  private _slotCount: number;
  private _freeSlots: number[];
  private readonly freeSet: Set<number>;
  private readonly store: CoarseStore;
  private readonly headerStore: CoarseHeaderStore;
  private readonly chunkSlots: number;

  private constructor(
    store: CoarseStore,
    headerStore: CoarseHeaderStore,
    header: CoarseVectorHeader,
    chunkSlots: number,
  ) {
    this.store = store;
    this.headerStore = headerStore;
    this.modelId = header.modelId;
    this._slotCount = header.slotCount;
    this._freeSlots = [...header.freeSlots];
    this.freeSet = new Set(this._freeSlots);
    this.chunkSlots = chunkSlots;
  }

  /**
   * Opens (creating if absent) the index over the given stores.
   *
   * - No header, no bytes: a fresh empty index is created and its header written.
   * - No header, bytes present: an error unless `adoptHeaderless` is set.
   * - Header present: validated, including that the buffer actually holds every
   *   slot the header claims.
   */
  static async open(
    store: CoarseStore,
    headerStore: CoarseHeaderStore,
    options: CoarseIndexOptions = {},
  ): Promise<CoarseIndex> {
    const chunkSlots = options.chunkSlots ?? DEFAULT_SCAN_CHUNK_SLOTS;
    if (!Number.isInteger(chunkSlots) || chunkSlots <= 0) {
      throw new CoarseIndexError('chunkSlots must be a positive integer');
    }
    const expectedModel = options.modelId ?? DEFAULT_MODEL_ID;

    const raw = await headerStore.readHeader().catch((err: unknown) => {
      throw new CoarseIndexError('Failed to read the coarse index header', err);
    });

    if (raw === null) {
      const size = await store.size().catch((err: unknown) => {
        throw new CoarseIndexError('Failed to size the coarse buffer', err);
      });
      if (size > 0 && !options.adoptHeaderless) {
        throw new CoarseIndexError(
          `Coarse buffer holds ${String(size)} bytes but has no header; pass adoptHeaderless ` +
            `to adopt them, or delete the buffer`,
        );
      }
      if (size > 0 && size % COARSE_VECTOR_DIM !== 0) {
        throw new CoarseIndexError(
          `Headerless coarse buffer of ${String(size)} bytes is not a whole number of ` +
            `${String(COARSE_VECTOR_DIM)}-byte slots; refusing to guess`,
        );
      }
      const header: CoarseVectorHeader = {
        modelId: expectedModel,
        coarseDim: COARSE_VECTOR_DIM,
        slotCount: size > 0 ? size / COARSE_VECTOR_DIM : 0,
        freeSlots: [],
      };
      const index = new CoarseIndex(store, headerStore, header, chunkSlots);
      await index.persistHeader();
      return index;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new CoarseIndexError('Coarse index header is not valid JSON', err);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new CoarseIndexError('Coarse index header must be a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    const header: CoarseVectorHeader = {
      modelId: typeof record['modelId'] === 'string' ? record['modelId'] : '',
      coarseDim: parseIntStrict(record['coarseDim'], 'coarseDim'),
      slotCount: parseIntStrict(record['slotCount'], 'slotCount'),
      freeSlots: Array.isArray(record['freeSlots'])
        ? (record['freeSlots'] as readonly number[])
        : [],
    };
    validateHeader(header, options);

    const size = await store.size().catch((err: unknown) => {
      throw new CoarseIndexError('Failed to size the coarse buffer', err);
    });
    if (size < header.slotCount * COARSE_VECTOR_DIM) {
      throw new CoarseIndexError(
        `Header claims ${String(header.slotCount)} slots (${String(
          header.slotCount * COARSE_VECTOR_DIM,
        )} bytes) but the buffer holds only ${String(size)} bytes`,
      );
    }
    return new CoarseIndex(store, headerStore, header, chunkSlots);
  }

  get slotCount(): number {
    return this._slotCount;
  }

  /** Slots not on the free-list. This is what a full search scan can reach. */
  get liveSlotCount(): number {
    return this._slotCount - this.freeSet.size;
  }

  /** A snapshot of the free-list. */
  get freeSlots(): readonly number[] {
    return [...this._freeSlots];
  }

  /** The current header as it would be persisted. */
  header(): CoarseVectorHeader {
    return {
      modelId: this.modelId,
      coarseDim: this.coarseDim,
      slotCount: this._slotCount,
      freeSlots: [...this._freeSlots],
    };
  }

  /**
   * Allocates a slot: reuses the most recently freed one when available,
   * otherwise appends. The header is persisted before returning, so a crash
   * between allocation and the caller's vector write can only leak a slot that
   * is either empty (new) or stale (reused) — never lost from the free-list.
   */
  async allocate(): Promise<number> {
    const reused = this._freeSlots.pop();
    if (reused !== undefined) {
      this.freeSet.delete(reused);
      await this.persistHeader();
      return reused;
    }
    const slot = this._slotCount;
    this._slotCount += 1;
    await this.persistHeader();
    return slot;
  }

  /**
   * Returns a slot to the free-list. The slot's bytes stay in place — stale
   * vectors are skipped by {@link scanSlots} — and the header is persisted
   * before returning.
   */
  async free(slot: number): Promise<void> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._slotCount) {
      throw new CoarseIndexError(`Slot ${String(slot)} is outside [0, ${String(this._slotCount)})`);
    }
    if (this.freeSet.has(slot)) {
      throw new CoarseIndexError(`Slot ${String(slot)} is already free`);
    }
    this.freeSet.add(slot);
    this._freeSlots.push(slot);
    await this.persistHeader();
  }

  /** Reads one slot's vector. */
  async readVector(slot: number): Promise<Int8Array> {
    this.assertLiveSlot(slot);
    const offset = slot * COARSE_VECTOR_DIM;
    const bytes = await this.store.read(offset, COARSE_VECTOR_DIM);
    return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * Writes one slot's vector. The slot must already be allocated (call
   * {@link allocate} first) — writing into a free slot would resurrect stale
   * bytes as if they were fresh. Writing the first vector of a newly appended
   * slot may grow the underlying store.
   */
  async writeVector(slot: number, vector: Int8Array): Promise<void> {
    if (vector.length !== COARSE_VECTOR_DIM) {
      throw new EmbeddingError(
        `Vector must have length ${String(COARSE_VECTOR_DIM)}; got ${String(vector.length)}`,
      );
    }
    this.assertLiveSlot(slot);
    const offset = slot * COARSE_VECTOR_DIM;
    const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    await this.store.write(offset, bytes);
  }

  /**
   * Streams every live slot's vector in slot order, reading the buffer in
   * chunks of `chunkSlots` so a scan never requires full residency. Freed
   * slots are skipped: their bytes are stale by definition, and a stale hit
   * would only be discarded after the expensive rerank in task 6.3.
   *
   * Each yielded vector is a fresh copy, safe to hold across awaits.
   */
  async *scanSlots(): AsyncGenerator<CoarseSlotVector> {
    if (this._slotCount === 0) return;
    for (let base = 0; base < this._slotCount; base += this.chunkSlots) {
      const slotsThisChunk = Math.min(this.chunkSlots, this._slotCount - base);
      const want = slotsThisChunk * COARSE_VECTOR_DIM;
      const bytes = await this.store.read(base * COARSE_VECTOR_DIM, want);
      if (bytes.byteLength !== want) {
        throw new CoarseIndexError(
          `Short read: wanted ${String(want)} bytes at slot ${String(base)}, ` +
            `got ${String(bytes.byteLength)}`,
        );
      }
      for (let i = 0; i < slotsThisChunk; i++) {
        const slot = base + i;
        if (this.freeSet.has(slot)) continue;
        const start = i * COARSE_VECTOR_DIM;
        const slice = bytes.subarray(start, start + COARSE_VECTOR_DIM);
        yield {
          slot,
          vector: new Int8Array(slice.buffer, slice.byteOffset, slice.byteLength),
        };
      }
      // The free-set cannot change mid-scan in the single-threaded JS model:
      // every mutation goes through awaits on this same event loop.
    }
  }

  private assertLiveSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._slotCount) {
      throw new CoarseIndexError(`Slot ${String(slot)} is outside [0, ${String(this._slotCount)})`);
    }
    if (this.freeSet.has(slot)) {
      throw new CoarseIndexError(`Slot ${String(slot)} is on the free-list; allocate it first`);
    }
  }

  private async persistHeader(): Promise<void> {
    await this.headerStore.writeHeader(JSON.stringify(this.header())).catch((err: unknown) => {
      throw new CoarseIndexError('Failed to persist the coarse index header', err);
    });
  }
}

/**
 * Runs synchronous work as a settled promise — a sync throw inside the executor
 * becomes a rejection, not a sync throw. The same helper shape the SQLite
 * drivers use for sync-behind-async-interface implementations.
 */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

/**
 * In-memory `CoarseStore`/`CoarseHeaderStore` pair: the reference implementation
 * and the test vehicle. Byte semantics match the contract: zero-padded growth,
 * exact-length reads, out-of-bounds reads reject.
 */
export class InMemoryCoarseStore implements CoarseStore, CoarseHeaderStore {
  private _bytes: Uint8Array;
  private _header: string | null;

  constructor(initialBytes?: Uint8Array, initialHeader?: string) {
    this._bytes = new Uint8Array(initialBytes?.byteLength ?? 0);
    if (initialBytes) this._bytes.set(initialBytes);
    this._header = initialHeader ?? null;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return settle(() => {
      if (offset < 0 || length < 0 || offset + length > this._bytes.byteLength) {
        throw new CoarseIndexError(
          `Read of [${String(offset)}, ${String(offset + length)}) exceeds ` +
            `${String(this._bytes.byteLength)} bytes`,
        );
      }
      return this._bytes.slice(offset, offset + length);
    });
  }

  write(offset: number, data: Uint8Array): Promise<void> {
    return settle(() => {
      if (offset < 0) {
        throw new CoarseIndexError(`Negative write offset ${String(offset)}`);
      }
      const end = offset + data.byteLength;
      if (end > this._bytes.byteLength) {
        // Zero-pad any gap so a first write at a new slot lands contiguously.
        const next = new Uint8Array(Math.max(end, Math.ceil(this._bytes.byteLength * 1.5)));
        next.set(this._bytes);
        this._bytes = next;
      }
      this._bytes.set(data, offset);
    });
  }

  size(): Promise<number> {
    return settle(() => this._bytes.byteLength);
  }

  readHeader(): Promise<string | null> {
    return settle(() => this._header);
  }

  writeHeader(json: string): Promise<void> {
    return settle(() => {
      this._header = json;
    });
  }
}
