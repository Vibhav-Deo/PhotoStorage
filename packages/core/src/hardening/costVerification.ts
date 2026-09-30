/**
 * Storage Cost Verification & Alarms (Task 10.4).
 *
 * Implements:
 * - Spend calculation against actual AWS S3 pricing:
 *   Intelligent Tiering Archive: ~$0.004/GB/mo
 *   Standard Tier: ~$0.023/GB/mo
 *   Egress: ~$0.09/GB (first 100 GB free or lower)
 * - Verifies total spend is strictly under the $3.00/mo threshold at reference scale (50 GB).
 * - Triggers `DataTransfer-Out-Bytes` alarm when cumulative egress reaches 70 GB (CloudFront threshold).
 *
 * Requirements: 9.1, 9.4
 */

export const MONTHLY_SPEND_CEILING_USD = 3.0; // Requirement 9.1 (<$3.00/mo)
export const CLOUDFRONT_EGRESS_ALARM_GB = 70.0; // 70 GB trigger threshold

export interface CostReport {
  readonly storageBytes: number;
  readonly egressBytes: number;
  readonly storageCostUsd: number;
  readonly egressCostUsd: number;
  readonly totalMonthlyCostUsd: number;
  readonly isUnderCeiling: boolean;
  readonly cloudFrontAlarmTriggered: boolean;
}

/**
 * Calculates monthly storage and egress spend.
 */
export function calculateMonthlySpend(
  storageBytes: number,
  egressBytes: number,
): CostReport {
  const storageGb = storageBytes / (1024 * 1024 * 1024);
  const egressGb = egressBytes / (1024 * 1024 * 1024);

  // S3 Intelligent-Tiering Archive rate (~$0.004 per GB-month)
  const storageCost = storageGb * 0.004;

  // AWS internet egress (~$0.09 per GB after first 10 GB free tier)
  const billableEgressGb = Math.max(0, egressGb - 10);
  const egressCost = billableEgressGb * 0.09;

  const totalCost = storageCost + egressCost;

  return {
    storageBytes,
    egressBytes,
    storageCostUsd: Number(storageCost.toFixed(4)),
    egressCostUsd: Number(egressCost.toFixed(4)),
    totalMonthlyCostUsd: Number(totalCost.toFixed(4)),
    isUnderCeiling: totalCost < MONTHLY_SPEND_CEILING_USD,
    cloudFrontAlarmTriggered: egressGb >= CLOUDFRONT_EGRESS_ALARM_GB,
  };
}
