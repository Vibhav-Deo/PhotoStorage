/**
 * Takeout import reconciliation report.
 *
 * Requirements:
 * - Counts for found, imported, deduplicated, skipped, failed.
 * - Per-item reason for everything not imported (Requirement 1.10).
 */

export interface ItemSkipDetail {
  readonly path: string;
  readonly reason: string;
  readonly detail?: string;
}

export interface ReconciliationReportInput {
  readonly totalFilesFound: number;
  readonly totalMediaFound: number;
  readonly importedCount: number;
  readonly deduplicatedCount: number;
  readonly skippedItems?: readonly ItemSkipDetail[];
  readonly failedItems?: readonly ItemSkipDetail[];
}

export interface ReconciliationReport {
  readonly totalFilesFound: number;
  readonly totalMediaFound: number;
  readonly importedCount: number;
  readonly deduplicatedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly skippedItems: readonly ItemSkipDetail[];
  readonly failedItems: readonly ItemSkipDetail[];
}

/**
 * Builds a structured reconciliation report summarizing the Takeout import run.
 */
export function buildReconciliationReport(input: ReconciliationReportInput): ReconciliationReport {
  const skippedItems = input.skippedItems ? [...input.skippedItems] : [];
  const failedItems = input.failedItems ? [...input.failedItems] : [];

  return {
    totalFilesFound: input.totalFilesFound,
    totalMediaFound: input.totalMediaFound,
    importedCount: input.importedCount,
    deduplicatedCount: input.deduplicatedCount,
    skippedCount: skippedItems.length,
    failedCount: failedItems.length,
    skippedItems,
    failedItems,
  };
}

/**
 * Formats a human-readable text summary of the reconciliation report.
 */
export function formatReconciliationReportSummary(report: ReconciliationReport): string {
  const lines: string[] = [
    '=== Google Takeout Import Reconciliation Report ===',
    `Total files found across archives: ${String(report.totalFilesFound)}`,
    `Total media assets found:         ${String(report.totalMediaFound)}`,
    `Successfully imported:            ${String(report.importedCount)}`,
    `Deduplicated (content matched):   ${String(report.deduplicatedCount)}`,
    `Skipped items:                     ${String(report.skippedCount)}`,
    `Failed items:                      ${String(report.failedCount)}`,
  ];

  if (report.skippedItems.length > 0) {
    lines.push('', '--- Skipped Items ---');
    for (const item of report.skippedItems) {
      const extra = item.detail ? ` (${item.detail})` : '';
      lines.push(` - ${item.path}: [${item.reason}]${extra}`);
    }
  }

  if (report.failedItems.length > 0) {
    lines.push('', '--- Failed Items ---');
    for (const item of report.failedItems) {
      const extra = item.detail ? ` (${item.detail})` : '';
      lines.push(` - ${item.path}: [${item.reason}]${extra}`);
    }
  }

  return lines.join('\n');
}
