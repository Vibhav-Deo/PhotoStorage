/**
 * The device's `CoarseStore`/`CoarseHeaderStore` pair over `expo-file-system`,
 * task 6.2.
 *
 * Two files: `coarse.bin` (packed vectors, positional access through a cached
 * `FileHandle`) and `coarse.json` (the header sidecar, whole-file text). Kept
 * deliberately thin — every byte-level decision lives in `@photo-archive/core`'s
 * `CoarseIndex`, which is where it is testable in Node. What remains here is
 * expo-file-system mechanics, which can only be exercised on a device:
 *
 * - Positional reads go through one long-lived handle; the hot path is
 *   `scanSlots`' chunked reads, and opening a handle per chunk would dominate
 *   scan latency.
 * - Growth never goes through the handle — `FileHandle.writeBytes` extension
 *   behaviour past EOF is undocumented, so appends use `File.write` with
 *   `{ append: true }` and the cached handle is dropped afterwards.
 * - Writing at an offset past EOF zero-pads the gap in the same append, so a
 *   first write at a new slot lands contiguously (the `CoarseStore` contract).
 */

import { FileMode } from 'expo-file-system';
import type { File, FileHandle } from 'expo-file-system';
import { CoarseIndexError } from '@photo-archive/core';
import type { CoarseHeaderStore, CoarseStore } from '@photo-archive/core';

/** Runs synchronous work as a settled promise; a sync throw becomes a rejection. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

export class ExpoCoarseStore implements CoarseStore, CoarseHeaderStore {
  private readonly bin: File;
  private readonly headerFile: File;
  private handle: FileHandle | null = null;

  constructor(bin: File, headerFile: File) {
    this.bin = bin;
    this.headerFile = headerFile;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return settle(() => {
      if (offset < 0 || length < 0) {
        throw new CoarseIndexError(`Negative read [${String(offset)}, +${String(length)})`);
      }
      if (!this.bin.exists) {
        throw new CoarseIndexError(`Coarse buffer '${this.bin.uri}' does not exist`);
      }
      const handle = this.ensureHandle();
      handle.offset = offset;
      const bytes = handle.readBytes(length);
      if (bytes.byteLength !== length) {
        throw new CoarseIndexError(
          `Short read of '${this.bin.uri}': wanted ${String(length)} at ` +
            `offset ${String(offset)}, got ${String(bytes.byteLength)}`,
        );
      }
      return bytes;
    });
  }

  write(offset: number, data: Uint8Array): Promise<void> {
    return settle(() => {
      if (offset < 0) {
        throw new CoarseIndexError(`Negative write offset ${String(offset)}`);
      }
      const size = this.bin.size;
      const end = offset + data.byteLength;

      if (offset >= size) {
        // Pure append with an optional zero-padded gap.
        if (!this.bin.exists) this.bin.create({ intermediates: true });
        const gap = offset - size;
        const payload = new Uint8Array(gap + data.byteLength);
        payload.set(data, gap);
        this.bin.write(payload, { append: true });
        this.releaseHandle(); // the file grew; reopen on next use
        return;
      }

      if (end <= size) {
        const handle = this.ensureHandle();
        handle.offset = offset;
        handle.writeBytes(data);
        return;
      }

      // Overlaps EOF: positional head, append tail.
      const head = size - offset;
      const handle = this.ensureHandle();
      handle.offset = offset;
      handle.writeBytes(data.subarray(0, head));
      this.releaseHandle();
      this.bin.write(data.subarray(head), { append: true });
    });
  }

  size(): Promise<number> {
    return settle(() => this.bin.size);
  }

  async readHeader(): Promise<string | null> {
    if (!this.headerFile.exists) return null;
    return await this.headerFile.text();
  }

  writeHeader(json: string): Promise<void> {
    return settle(() => {
      if (!this.headerFile.exists) {
        this.headerFile.create({ intermediates: true });
      }
      this.headerFile.write(json);
    });
  }

  /** Releases the cached read handle. Call when the store is no longer needed. */
  close(): void {
    this.releaseHandle();
  }

  private ensureHandle(): FileHandle {
    if (this.handle === null) {
      try {
        this.handle = this.bin.open(FileMode.ReadWrite);
      } catch (err) {
        throw new CoarseIndexError(`Failed to open '${this.bin.uri}' for positional access`, err);
      }
    }
    return this.handle;
  }

  private releaseHandle(): void {
    this.handle?.close();
    this.handle = null;
  }
}
