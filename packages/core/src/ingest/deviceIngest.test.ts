import { describe, expect, it } from 'vitest';
import {
  checkIngestBackpressure,
  enumerateDeviceAssets,
  queryIngestLibraryStatus,
  materializeOriginal,
  BoundedUploadPool,
  uploadDeviceAsset,
  type DeviceEnvironmentState,
  type DeviceAssetInfo,
} from './deviceIngest.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';
import { Platform, RemoteState } from '../states.ts';
import { LocalFsObjectStore } from '../store/localFsObjectStore.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

describe('Device Ingest Backpressure (Task 7.6)', () => {
  it('pauses when thermal throttle is serious or critical', () => {
    const nominal: DeviceEnvironmentState = {
      thermalState: 'nominal',
      batteryLevel: 0.8,
      isCharging: false,
      isMeteredNetwork: false,
      userOptedIntoMetered: false,
    };
    expect(checkIngestBackpressure(nominal).shouldPause).toBe(false);

    const throttled: DeviceEnvironmentState = {
      ...nominal,
      thermalState: 'serious',
    };
    const res = checkIngestBackpressure(throttled);
    expect(res.shouldPause).toBe(true);
    expect(res.reason).toBe('thermal_throttle');
  });

  it('pauses below 20% battery unless charging', () => {
    const lowBattery: DeviceEnvironmentState = {
      thermalState: 'nominal',
      batteryLevel: 0.15,
      isCharging: false,
      isMeteredNetwork: false,
      userOptedIntoMetered: false,
    };
    const res1 = checkIngestBackpressure(lowBattery);
    expect(res1.shouldPause).toBe(true);
    expect(res1.reason).toBe('battery_low');

    const lowBatteryCharging: DeviceEnvironmentState = {
      ...lowBattery,
      isCharging: true,
    };
    expect(checkIngestBackpressure(lowBatteryCharging).shouldPause).toBe(false);
  });

  it('defers on metered network unless opted in', () => {
    const metered: DeviceEnvironmentState = {
      thermalState: 'nominal',
      batteryLevel: 0.8,
      isCharging: false,
      isMeteredNetwork: true,
      userOptedIntoMetered: false,
    };
    const res1 = checkIngestBackpressure(metered);
    expect(res1.shouldPause).toBe(true);
    expect(res1.reason).toBe('metered_network');

    const meteredOptIn: DeviceEnvironmentState = {
      ...metered,
      userOptedIntoMetered: true,
    };
    expect(checkIngestBackpressure(meteredOptIn).shouldPause).toBe(false);
  });
});

describe('Device Library Enumeration & Status (Tasks 7.1, 7.7)', () => {
  it('enumerates new local assets, enqueues hash jobs, and preserves unchanged on re-run', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const batch1: DeviceAssetInfo[] = [
      { localId: 'ph_001', platform: Platform.Ios },
      { localId: 'ph_002', platform: Platform.Ios },
    ];

    const res1 = await enumerateDeviceAssets(driver, batch1, 'authorized');
    expect(res1.newCount).toBe(2);
    expect(res1.unchangedCount).toBe(0);

    // Jobs table must contain 2 Hash jobs (kind = 1)
    const jobs = await driver.all<{ kind: number; local_id: string }>(
      'SELECT kind, local_id FROM jobs ORDER BY local_id',
    );
    expect(jobs).toEqual([
      { kind: 1, local_id: 'ph_001' },
      { kind: 1, local_id: 'ph_002' },
    ]);

    // Re-run enumeration with ph_001, ph_002, plus a new ph_003
    const batch2: DeviceAssetInfo[] = [
      { localId: 'ph_001', platform: Platform.Ios },
      { localId: 'ph_002', platform: Platform.Ios },
      { localId: 'ph_003', platform: Platform.Ios },
    ];

    const res2 = await enumerateDeviceAssets(driver, batch2, 'limited');
    expect(res2.newCount).toBe(1);
    expect(res2.unchangedCount).toBe(2);
    expect(res2.isLimitedAccess).toBe(true);

    const status = await queryIngestLibraryStatus(driver);
    expect(status.totalLocal).toBe(3);
    expect(status.unhashed).toBe(3);

    driver.close();
  });

  it('materializes non-resident originals and transitions hash state (Task 7.2)', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    await driver.run(
      'INSERT INTO local_assets (local_id, platform, hash_state, first_seen, last_seen) VALUES (?, ?, 0, ?, ?)',
      ['ph_cloud_1', Platform.Ios, 1000, 1000],
    );

    const mockFetchCloud = (id: string) => {
      expect(id).toBe('ph_cloud_1');
      return Promise.resolve(new TextEncoder().encode('cloud-resident original bytes'));
    };

    const res = await materializeOriginal(driver, 'ph_cloud_1', mockFetchCloud, true);
    expect(res.downloadedFromCloud).toBe(true);
    expect(res.byteSize).toBeGreaterThan(0);
    expect(res.hash.length).toBe(64);

    const row = await driver.all<{ hash: string; hash_state: number }>(
      'SELECT hash, hash_state FROM local_assets WHERE local_id = ?',
      ['ph_cloud_1'],
    );
    expect(row[0]?.hash_state).toBe(1);
    expect(row[0]?.hash).toBe(res.hash);

    driver.close();
  });

  it('bounds upload concurrency and uploads asset with checksums (Task 7.4)', async () => {
    // 1. Test BoundedUploadPool
    const pool = new BoundedUploadPool(2);
    let active = 0;
    let maxObservedActive = 0;

    const task = async () => {
      active++;
      maxObservedActive = Math.max(maxObservedActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    };

    await Promise.all([
      pool.run(task),
      pool.run(task),
      pool.run(task),
      pool.run(task),
    ]);

    expect(maxObservedActive).toBeLessThanOrEqual(2);

    // 2. Test uploadDeviceAsset
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-upload-'));
    const store = new LocalFsObjectStore({ root: tmpDir });
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const testBytes = new TextEncoder().encode('sample photo payload for s3 upload');
    const testHash = 'b'.repeat(64);

    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, updated_at)
       VALUES (?, 0, ?, 'image/jpeg', 1000, 0, X'00', 0, 1, 1000)`,
      [testHash, testBytes.byteLength],
    );

    const uploadRes = await uploadDeviceAsset(store, 'usr_sub', testHash, testBytes, driver);
    expect(uploadRes.hash).toBe(testHash);
    expect(uploadRes.isMultipart).toBe(false);

    // Verify remote asset state updated to Uploading (only verification promotes to Verified)
    const assetRow = await driver.all<{ remote_state: number }>(
      'SELECT remote_state FROM assets WHERE hash = ?',
      [testHash],
    );
    expect(assetRow[0]?.remote_state).toBe(RemoteState.Uploading);

    driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

