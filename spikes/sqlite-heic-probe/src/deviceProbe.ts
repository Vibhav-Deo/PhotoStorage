/**
 * Wires the on-device SQLite driver into the shared grading harness.
 *
 * Deliberately thin. All the search logic lives in `sqlite-heic-probe-core` so the
 * device and the Node reference are graded by the same code; the only thing this
 * adds is opening and closing the database.
 */

import {
  runSearchProbe,
  type SearchProbeReport,
} from '../../sqlite-heic-probe-core/src/index.ts';
import { ExpoSqliteDriver } from './expoSqliteDriver.ts';

export async function probeSearchOnDevice(): Promise<SearchProbeReport> {
  const driver = await ExpoSqliteDriver.open();
  try {
    return await runSearchProbe(driver);
  } finally {
    await driver.close();
  }
}
