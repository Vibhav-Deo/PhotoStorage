/**
 * Opens the on-device SQLite database, applies connection pragmas, and runs the
 * migration runner from `@photo-archive/core`.
 *
 * Called once at app startup before any service accesses the database.
 * The `SQLiteProvider` in App.tsx opens the handle; this function receives it.
 *
 * Requirements: 4.1
 */

import { applyConnectionPragmas, migrate } from '@photo-archive/core';
import type { MigrationResult } from '@photo-archive/core';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ExpoSqliteDriver } from './expoSqliteDriver.ts';

export { ExpoSqliteDriver };

/**
 * Prepares the database for use: applies connection pragmas and runs pending migrations.
 * Safe to call on every launch — a current database performs one read and no writes.
 */
export async function initDatabase(db: SQLiteDatabase): Promise<MigrationResult> {
  const driver = new ExpoSqliteDriver(db);
  await applyConnectionPragmas(driver);
  return migrate(driver);
}
