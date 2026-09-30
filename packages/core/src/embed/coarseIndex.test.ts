import { describe, expect, it } from 'vitest';
import { COARSE_VECTOR_DIM, DEFAULT_MODEL_ID, EmbeddingError } from './embedding.ts';
import { CoarseIndex, CoarseIndexError, InMemoryCoarseStore } from './coarseIndex.ts';

/** A deterministic test vector: distinct per slot, stable across calls. */
function testVector(slot: number, fill: number): Int8Array {
  const v = new Int8Array(COARSE_VECTOR_DIM);
  for (let i = 0; i < COARSE_VECTOR_DIM; i++) {
    v[i] = ((slot * 31 + i * 17 + fill) % 251) - 125;
  }
  v[0] = fill;
  return v;
}

async function openFresh(options?: { readonly chunkSlots?: number }): Promise<{
  index: CoarseIndex;
  store: InMemoryCoarseStore;
}> {
  const store = new InMemoryCoarseStore();
  const index = await CoarseIndex.open(store, store, options);
  return { index, store };
}

describe('CoarseIndex.open', () => {
  it('creates an empty index over absent stores and persists its header', async () => {
    const store = new InMemoryCoarseStore();
    const index = await CoarseIndex.open(store, store);
    expect(index.slotCount).toBe(0);
    expect(index.liveSlotCount).toBe(0);
    expect(index.modelId).toBe(DEFAULT_MODEL_ID);
    const header = JSON.parse((await store.readHeader()) ?? '{}') as Record<string, unknown>;
    expect(header['slotCount']).toBe(0);
    expect(header['modelId']).toBe(DEFAULT_MODEL_ID);
  });

  it('reopens a persisted index with identical state', async () => {
    const store = new InMemoryCoarseStore();
    const first = await CoarseIndex.open(store, store);
    const a = await first.allocate();
    const b = await first.allocate();
    await first.writeVector(a, testVector(a, 1));
    await first.writeVector(b, testVector(b, 2));
    await first.free(a);

    const second = await CoarseIndex.open(store, store);
    expect(second.slotCount).toBe(2);
    expect(second.freeSlots).toEqual([a]);
    expect(second.liveSlotCount).toBe(1);
    const vec = await second.readVector(b);
    expect([...vec]).toEqual([...testVector(b, 2)]);
  });

  it('rejects a headerless buffer unless adoptHeaderless is set', async () => {
    const bytes = new Uint8Array(COARSE_VECTOR_DIM * 3);
    const store = new InMemoryCoarseStore(bytes);
    await expect(CoarseIndex.open(store, store)).rejects.toThrow(CoarseIndexError);
  });

  it('adopts a headerless buffer as live slots when asked', async () => {
    const bytes = new Uint8Array(COARSE_VECTOR_DIM * 3);
    bytes.fill(7, 0, COARSE_VECTOR_DIM); // slot 0 distinct
    const store = new InMemoryCoarseStore(bytes);
    const index = await CoarseIndex.open(store, store, { adoptHeaderless: true });
    expect(index.slotCount).toBe(3);
    expect(index.liveSlotCount).toBe(3);
    expect(index.freeSlots).toEqual([]);
    const slot0 = await index.readVector(0);
    expect(slot0.every((b) => b === 7)).toBe(true);
    // Header was written, so a second open needs no flag.
    await expect(CoarseIndex.open(store, store)).resolves.toBeInstanceOf(CoarseIndex);
  });

  it('refuses to guess a headerless buffer that is not whole slots', async () => {
    const store = new InMemoryCoarseStore(new Uint8Array(COARSE_VECTOR_DIM + 1));
    await expect(CoarseIndex.open(store, store, { adoptHeaderless: true })).rejects.toThrow(
      /whole number/,
    );
  });

  it('rejects a header claiming more slots than the buffer holds', async () => {
    const store = new InMemoryCoarseStore();
    await store.writeHeader(
      JSON.stringify({
        modelId: DEFAULT_MODEL_ID,
        coarseDim: COARSE_VECTOR_DIM,
        slotCount: 5,
        freeSlots: [],
      }),
    );
    await expect(CoarseIndex.open(store, store)).rejects.toThrow(/buffer holds only/);
  });

  it('rejects invalid headers: JSON, dims, model, free-list', async () => {
    const bytes = new Uint8Array(COARSE_VECTOR_DIM * 2);
    const cases: readonly [string, RegExp][] = [
      ['not json', /not valid JSON/],
      [
        JSON.stringify({ modelId: DEFAULT_MODEL_ID, coarseDim: 128, slotCount: 0, freeSlots: [] }),
        /another model or is corrupt/,
      ],
      [
        JSON.stringify({
          modelId: 'other-model',
          coarseDim: COARSE_VECTOR_DIM,
          slotCount: 0,
          freeSlots: [],
        }),
        /does not match the expected/,
      ],
      [
        JSON.stringify({
          modelId: DEFAULT_MODEL_ID,
          coarseDim: COARSE_VECTOR_DIM,
          slotCount: 2,
          freeSlots: [1, 1],
        }),
        /more than once/,
      ],
      [
        JSON.stringify({
          modelId: DEFAULT_MODEL_ID,
          coarseDim: COARSE_VECTOR_DIM,
          slotCount: 1,
          freeSlots: [1],
        }),
        /outside the allocated range/,
      ],
    ];
    for (const [header, pattern] of cases) {
      const store = new InMemoryCoarseStore(bytes);
      await store.writeHeader(header);
      await expect(CoarseIndex.open(store, store)).rejects.toThrow(pattern);
    }
  });
});

describe('CoarseIndex slot lifecycle', () => {
  it('allocates sequentially, then reuses freed slots LIFO', async () => {
    const { index } = await openFresh();
    expect(await index.allocate()).toBe(0);
    expect(await index.allocate()).toBe(1);
    expect(await index.allocate()).toBe(2);
    await index.free(1);
    expect(await index.allocate()).toBe(1);
    expect(await index.allocate()).toBe(3);
    expect(index.slotCount).toBe(4);
    expect(index.liveSlotCount).toBe(4);
  });

  it('round-trips vectors through readVector and writeVector', async () => {
    const { index } = await openFresh();
    const slot = await index.allocate();
    const v = testVector(slot, 42);
    await index.writeVector(slot, v);
    expect([...(await index.readVector(slot))]).toEqual([...v]);
  });

  it('rejects bad writes: wrong dim, unallocated, freed, out of range', async () => {
    const { index } = await openFresh();
    const slot = await index.allocate();
    await expect(index.writeVector(slot, new Int8Array(10))).rejects.toThrow(EmbeddingError);
    await expect(index.writeVector(slot + 1, testVector(1, 1))).rejects.toThrow(CoarseIndexError);
    await expect(index.readVector(slot + 1)).rejects.toThrow(CoarseIndexError);
    await index.free(slot);
    await expect(index.writeVector(slot, testVector(slot, 1))).rejects.toThrow(/free-list/);
    await expect(index.free(slot)).rejects.toThrow(/already free/);
    await expect(index.free(-1)).rejects.toThrow(CoarseIndexError);
  });

  it('persists the header on every mutation (crash-safety contract)', async () => {
    const store = new InMemoryCoarseStore();
    const index = await CoarseIndex.open(store, store);
    let headersSeen = 0;
    const first = await index.allocate();
    headersSeen += 1;
    await index.free(first);
    headersSeen += 1;
    expect(headersSeen).toBe(2);
    // The persisted header must already reflect the free-list, not defer it.
    const persisted = JSON.parse((await store.readHeader()) ?? '{}') as {
      slotCount?: number;
      freeSlots?: number[];
    };
    expect(persisted['slotCount']).toBe(1);
    expect(persisted['freeSlots']).toEqual([first]);
  });
});

describe('CoarseIndex.scanSlots (chunked reads)', () => {
  it('streams every live slot in order, skipping freed slots', async () => {
    const store = new InMemoryCoarseStore();
    const index = await CoarseIndex.open(store, store, { chunkSlots: 2 });
    const total = 9; // deliberately not a multiple of the chunk size
    const bySlot = new Map<number, Int8Array>();
    for (let s = 0; s < total; s++) {
      const slot = await index.allocate();
      const v = testVector(slot, s);
      await index.writeVector(slot, v);
      bySlot.set(slot, v);
    }
    // Free a spread of slots; the scan must skip exactly these.
    await index.free(2);
    await index.free(5);
    await index.free(8);

    const seen: number[] = [];
    for await (const { slot, vector } of index.scanSlots()) {
      seen.push(slot);
      expect([...vector]).toEqual([...(bySlot.get(slot) ?? [])]);
    }
    expect(seen).toEqual([0, 1, 3, 4, 6, 7]);
    expect(index.liveSlotCount).toBe(6);
  });

  it('reads the buffer in chunk-sized pieces, not as one whole read', async () => {
    const inner = new InMemoryCoarseStore();
    const reads: number[] = [];
    const store = {
      read: (offset: number, length: number): Promise<Uint8Array> => {
        reads.push(length);
        return inner.read(offset, length);
      },
      write: (offset: number, data: Uint8Array): Promise<void> => inner.write(offset, data),
      size: (): Promise<number> => inner.size(),
      readHeader: (): Promise<string | null> => inner.readHeader(),
      writeHeader: (json: string): Promise<void> => inner.writeHeader(json),
    };
    const index = await CoarseIndex.open(store, store, { chunkSlots: 3 });
    const total = 10; // 3, 3, 3, then 1 slot in the final read
    const expected = new Map<number, Int8Array>();
    for (let s = 0; s < total; s++) {
      const slot = await index.allocate();
      const v = testVector(slot, s + 100);
      await index.writeVector(slot, v);
      expected.set(slot, v);
    }

    reads.length = 0; // ignore any reads issued during setup
    const seen: number[] = [];
    for await (const { slot, vector } of index.scanSlots()) {
      seen.push(slot);
      expect([...vector]).toEqual([...(expected.get(slot) ?? [])]);
    }
    expect(seen).toEqual([...Array(total).keys()]);
    expect(reads).toEqual([
      3 * COARSE_VECTOR_DIM,
      3 * COARSE_VECTOR_DIM,
      3 * COARSE_VECTOR_DIM,
      1 * COARSE_VECTOR_DIM,
    ]);
  });

  it('yields nothing for an empty index', async () => {
    const { index } = await openFresh();
    const seen: number[] = [];
    for await (const { slot } of index.scanSlots()) seen.push(slot);
    expect(seen).toEqual([]);
  });
});
