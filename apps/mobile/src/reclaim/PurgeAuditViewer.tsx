/**
 * Purge Audit Trail Viewer (Task 8.6).
 *
 * Implements:
 * - User-inspectable audit trail that is never automatically pruned.
 * - Displays verified timestamps, byte size, method, and outcome.
 *
 * Requirements: 6.10, 6.11
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SqlDriver } from '@photo-archive/core';

export interface AuditEntry {
  readonly id: number;
  readonly hash: string;
  readonly remoteKey: string;
  readonly byteSize: number;
  readonly outcome: number;
  readonly verifiedAt: number;
}

interface PurgeAuditViewerProps {
  readonly driver: SqlDriver;
  readonly onClose?: () => void;
}

export function PurgeAuditViewer({
  driver,
  onClose,
}: PurgeAuditViewerProps): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAudit() {
      try {
        const rows = await driver.all<{
          id: number;
          hash: string;
          remote_key: string;
          byte_size: number;
          outcome: number;
          verified_at: number;
        }>(
          `SELECT id, hash, remote_key, byte_size, outcome, verified_at
           FROM purge_audit
           ORDER BY id DESC LIMIT 100`,
        );

        setEntries(
          rows.map((r) => ({
            id: r.id,
            hash: r.hash,
            remoteKey: r.remote_key,
            byteSize: r.byte_size,
            outcome: r.outcome,
            verifiedAt: r.verified_at,
          })),
        );
      } catch (err) {
        console.error('Failed to load purge audit:', err);
      } finally {
        setLoading(false);
      }
    }
    void loadAudit();
  }, [driver]);

  const outcomeLabel = (outcome: number): { text: string; color: string } => {
    if (outcome === 0) return { text: 'Purged', color: '#34d399' };
    if (outcome === 1) return { text: 'Declined', color: '#f59e0b' };
    return { text: 'Failed', color: '#ef4444' };
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Reclamation Audit Trail</Text>
        {onClose && (
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>Done</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.subtitle}>
        Permanent, immutable ledger of all verified local deletions (Requirement 6.10).
      </Text>

      {entries.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No purge operations recorded yet.</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => {
            const out = outcomeLabel(item.outcome);
            const dateStr = new Date(item.verifiedAt).toLocaleString();
            return (
              <View style={styles.row}>
                <View style={styles.rowHeader}>
                  <Text style={[styles.badge, { backgroundColor: `${out.color}22`, color: out.color }]}>
                    {out.text}
                  </Text>
                  <Text style={styles.dateText}>{dateStr}</Text>
                </View>
                <Text numberOfLines={1} style={styles.hashText}>
                  Hash: {item.hash}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>Size: {formatSize(item.byteSize)}</Text>
                  <Text numberOfLines={1} style={styles.keyText}>
                    {item.remoteKey}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    padding: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  subtitle: {
    fontSize: 13,
    color: '#a3a3a3',
    marginBottom: 16,
  },
  closeBtn: {
    backgroundColor: '#262626',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  closeBtnText: {
    color: '#fff',
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    color: '#737373',
    fontSize: 15,
  },
  row: {
    backgroundColor: '#171717',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#262626',
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    textTransform: 'uppercase',
  },
  dateText: {
    color: '#737373',
    fontSize: 11,
  },
  hashText: {
    color: '#e5e5e5',
    fontFamily: 'monospace',
    fontSize: 12,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaText: {
    color: '#a3a3a3',
    fontSize: 12,
  },
  keyText: {
    color: '#737373',
    fontSize: 11,
    maxWidth: '60%',
  },
});
