/**
 * Space Reclamation Modal UI (Task 8.4, 8.5).
 *
 * Implements:
 * - Disclosure of item count, total bytes to be freed.
 * - Explicit disclosure that local purge removes items from iCloud Photos if synced (Req 6.7).
 * - Single-prompt batched deletion execution.
 *
 * Requirements: 6.6, 6.7
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SqlDriver } from '@photo-archive/core';
import { executePurgeBatch } from '@photo-archive/core';

interface ReclaimModalProps {
  readonly visible: boolean;
  readonly driver: SqlDriver;
  readonly tenantPrefix: string;
  readonly eligibleHashes: readonly string[];
  readonly totalBytes: number;
  readonly platformDeleter: (hashes: readonly string[]) => Promise<{ deleted: string[]; declined?: boolean }>;
  readonly onClose: () => void;
  readonly onCompleted?: (freedBytes: number, count: number) => void;
}

export function ReclaimModal({
  visible,
  driver,
  tenantPrefix,
  eligibleHashes,
  totalBytes,
  platformDeleter,
  onClose,
  onCompleted,
}: ReclaimModalProps): React.ReactElement {
  const [purging, setPurging] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const handleConfirmPurge = async () => {
    setPurging(true);
    setStatusMessage('Verifying safety guarantees and deleting local originals...');
    try {
      const result = await executePurgeBatch(
        driver,
        tenantPrefix,
        eligibleHashes,
        platformDeleter,
      );

      if (result.declined) {
        setStatusMessage('Reclamation declined: no local files were removed.');
      } else {
        setStatusMessage(
          `Successfully freed ${formatSize(result.freedBytes)} across ${String(result.purgedCount)} assets.`,
        );
        onCompleted?.(result.freedBytes, result.purgedCount);
      }
    } catch (err) {
      setStatusMessage(`Purge error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPurging(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Free Up Device Space</Text>

          <View style={styles.highlightBox}>
            <Text style={styles.highlightNumber}>{formatSize(totalBytes)}</Text>
            <Text style={styles.highlightSub}>{eligibleHashes.length} Verified Originals</Text>
          </View>

          <View style={styles.disclosureContainer}>
            <Text style={styles.disclosureHeader}>Important Disclosures (Requirement 6.7):</Text>
            <Text style={styles.disclosureItem}>
              • 100% Verified: Every original has been bit-for-bit verified in your remote backup.
            </Text>
            <Text style={styles.disclosureItem}>
              • Browsable Offline: Fast thumbnails and previews remain instantly accessible on your device.
            </Text>
            <Text style={[styles.disclosureItem, styles.warningText]}>
              • Notice: Deleting local originals may also remove them from iCloud Photos or Google Photos sync.
            </Text>
          </View>

          {statusMessage && (
            <Text style={styles.statusText}>{statusMessage}</Text>
          )}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              disabled={purging}
              onPress={onClose}
              style={[styles.btn, styles.cancelBtn]}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              disabled={purging || eligibleHashes.length === 0}
              onPress={handleConfirmPurge}
              style={[styles.btn, styles.confirmBtn, (purging || eligibleHashes.length === 0) && styles.disabledBtn]}
            >
              {purging ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.confirmBtnText}>Free Space Now</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#171717',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#262626',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 16,
    textAlign: 'center',
  },
  highlightBox: {
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#262626',
  },
  highlightNumber: {
    fontSize: 28,
    fontWeight: '800',
    color: '#34d399',
  },
  highlightSub: {
    fontSize: 13,
    color: '#a3a3a3',
    marginTop: 4,
  },
  disclosureContainer: {
    backgroundColor: '#262626',
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
  },
  disclosureHeader: {
    color: '#e5e5e5',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  disclosureItem: {
    color: '#d4d4d4',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  warningText: {
    color: '#f87171',
    fontWeight: '600',
  },
  statusText: {
    color: '#e5e5e5',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: '#262626',
  },
  cancelBtnText: {
    color: '#e5e5e5',
    fontWeight: '600',
  },
  confirmBtn: {
    backgroundColor: '#dc2626',
  },
  confirmBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
  disabledBtn: {
    opacity: 0.5,
  },
});
