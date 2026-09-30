import { describe, expect, it } from 'vitest';
import type { ReconciliationReportInput } from './reconciliation.ts';
import { buildReconciliationReport, formatReconciliationReportSummary } from './reconciliation.ts';

describe('reconciliation report', () => {
  it('builds structured reconciliation report with counts and skip reasons', () => {
    const input: ReconciliationReportInput = {
      totalFilesFound: 100,
      totalMediaFound: 80,
      importedCount: 70,
      deduplicatedCount: 5,
      skippedItems: [
        { path: 'Trash/bad.jpg', reason: 'trash_opt_out' },
        { path: 'corrupt.raw', reason: 'unsupported_extension', detail: '.raw' },
      ],
      failedItems: [
        { path: 'broken.mp4', reason: 'ffmpeg_transcode_failed', detail: 'exit code 1' },
      ],
    };

    const report = buildReconciliationReport(input);

    expect(report.totalFilesFound).toBe(100);
    expect(report.totalMediaFound).toBe(80);
    expect(report.importedCount).toBe(70);
    expect(report.deduplicatedCount).toBe(5);
    expect(report.skippedCount).toBe(2);
    expect(report.failedCount).toBe(1);

    const text = formatReconciliationReportSummary(report);
    expect(text).toContain('Google Takeout Import Reconciliation Report');
    expect(text).toContain('Successfully imported:            70');
    expect(text).toContain('Trash/bad.jpg: [trash_opt_out]');
    expect(text).toContain('broken.mp4: [ffmpeg_transcode_failed]');
  });
});
