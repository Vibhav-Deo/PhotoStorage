/**
 * Device Ingest Status UI (Task 7.7).
 *
 * Surfaces library-wide ingest counters (unhashed, uploading, verified, failed)
 * and dead-lettered jobs with actionable retry controls.
 *
 * Requirements: 2.7
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
import { queryIngestLibraryStatus, type IngestLibraryStatus } from '@photo-archive/core';

interface IngestStatusViewProps {
  readonly driver: SqlDriver;
  readonly onRetryJob?: (jobId: number) => Promise<void>;
  readonly onClose?: () => void;
}

export function IngestStatusView({
  driver,
  onRetryJob,
  onClose,
}: IngestStatusViewProps): React.ReactElement {
  const [status, setStatus] = useState<IngestLibraryStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = async () => {
    try {
      const s = await queryIngestLibraryStatus(driver);
      setStatus(s);
    } catch (err) {
      console.error('Failed to load ingest status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, [driver]);

  if (loading || !status) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Library Backup Status</Text>
        {onClose && (
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>Done</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.statsGrid}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{status.totalLocal}</Text>
          <Text style={styles.statLabel}>Local Items</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{status.verified}</Text>
          <Text style={styles.statLabel}>Backed Up</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: '#f59e0b' }]}>{status.uploading}</Text>
          <Text style={styles.statLabel}>Uploading</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: '#ef4444' }]}>{status.failed}</Text>
          <Text style={styles.statLabel}>Failed</Text>
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>
          Dead-Lettered Items ({status.deadLetters.length})
        </Text>
      </View>

      {status.deadLetters.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>All library items processed smoothly.</Text>
        </View>
      ) : (
        <FlatList
          data={status.deadLetters}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <View style={styles.deadItem}>
              <View style={styles.deadInfo}>
                <Text style={styles.deadLocalId}>ID: {item.localId ?? 'Unknown'}</Text>
                <Text style={styles.deadError}>{item.lastError ?? 'Exceeded max retry attempts'}</Text>
              </View>
              {onRetryJob && (
                <TouchableOpacity
                  onPress={() => {
                    void onRetryJob(item.id).then(loadStatus);
                  }}
                  style={styles.retryBtn}
                >
                  <Text style={styles.retryBtnText}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
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
    marginBottom: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#262626',
  },
  closeBtnText: {
    color: '#fff',
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: '#171717',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#262626',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: '#a3a3a3',
    textTransform: 'uppercase',
  },
  sectionHeader: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e5e5e5',
  },
  emptyState: {
    padding: 24,
    backgroundColor: '#171717',
    borderRadius: 12,
    alignItems: 'center',
  },
  emptyText: {
    color: '#737373',
    fontSize: 14,
  },
  deadItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#171717',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#262626',
  },
  deadInfo: {
    flex: 1,
    marginRight: 12,
  },
  deadLocalId: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  deadError: {
    color: '#ef4444',
    fontSize: 12,
  },
  retryBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
});
