/**
 * Spike UI for photo-archive task 0.2.
 *
 * Plain by intention, like spike 0.1's: the output is meant to be read off the
 * screen and pasted into the design's open questions section, so everything that
 * matters is text.
 *
 * Three buttons rather than one, because the three things being measured have
 * different risk profiles. The search probe is harmless. The HEIC probe allocates
 * large bitmaps. The concurrency stress deliberately tries to exhaust the heap, and
 * if it succeeds the process is killed and reports nothing — so it must be possible
 * to record the first two results before running it.
 */

import { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import type { SearchProbeReport } from '../sqlite-heic-probe-core/src/index.ts';
import { probeSearchOnDevice } from './src/deviceProbe.ts';
import { probeHeic, type HeicProbeOutcome, type HeicProgress } from './src/heicProbe.ts';

type Busy = 'none' | 'search' | 'heic' | 'stress';

export default function App() {
  const [busy, setBusy] = useState<Busy>('none');
  const [status, setStatus] = useState('Not started');
  const [search, setSearch] = useState<SearchProbeReport | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [heic, setHeic] = useState<HeicProbeOutcome | null>(null);
  const [heicError, setHeicError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setBusy('search');
    setSearch(null);
    setSearchError(null);
    setStatus('opening the database');
    try {
      setSearch(await probeSearchOnDevice());
      setStatus('search probe complete');
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : String(error));
      setStatus('search probe failed');
    } finally {
      setBusy('none');
    }
  }, []);

  const runHeic = useCallback(
    async (includeConcurrencyStress: boolean) => {
      setBusy(includeConcurrencyStress ? 'stress' : 'heic');
      setHeic(null);
      setHeicError(null);
      const onProgress = (progress: HeicProgress) => setStatus(progress.detail);
      try {
        setHeic(await probeHeic(onProgress, { includeConcurrencyStress }));
        setStatus('HEIC probe complete');
      } catch (error) {
        setHeicError(error instanceof Error ? error.message : String(error));
        setStatus('HEIC probe failed');
      } finally {
        setBusy('none');
      }
    },
    []
  );

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>FTS5 + HEIC spike</Text>
        <Text style={styles.subtitle}>
          {Platform.OS} {String(Platform.Version)}
        </Text>

        <Button
          label="1. Run search probe (FTS5 + fallback)"
          busy={busy === 'search'}
          disabled={busy !== 'none'}
          onPress={runSearch}
        />
        <Button
          label="2. Run HEIC decode probe"
          busy={busy === 'heic'}
          disabled={busy !== 'none'}
          onPress={() => runHeic(false)}
        />
        <Button
          label="3. Run HEIC probe + concurrency stress"
          busy={busy === 'stress'}
          disabled={busy !== 'none'}
          onPress={() => runHeic(true)}
          destructive
        />
        <Text style={styles.note}>
          Step 3 runs four full-resolution decodes at once, which is the design&apos;s
          Derive concurrency. If the app is killed for memory, that is the result —
          record steps 1 and 2 first.
        </Text>

        <Section title="Status">
          <Text style={styles.mono} accessibilityLiveRegion="polite">
            {status}
          </Text>
        </Section>

        {searchError ? (
          <Section title="Search probe error">
            <Text style={[styles.mono, styles.bad]}>{searchError}</Text>
          </Section>
        ) : null}

        {search ? <SearchResult report={search} /> : null}

        {heicError ? (
          <Section title="HEIC probe error">
            <Text style={[styles.mono, styles.bad]}>{heicError}</Text>
          </Section>
        ) : null}

        {heic ? (
          <Section title={`HEIC verdict: ${heic.verdict.toUpperCase()}`}>
            <Text style={[styles.mono, heic.verdict === 'pass' ? styles.good : styles.bad]}>
              {heic.summary}
            </Text>
            <Text style={styles.note}>
              Compare `full-decode` against `subsampled-decode`. The gap in decoded
              megabytes is what the design&apos;s Derive stage would be paying for
              nothing.
            </Text>
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SearchResult({ report }: { report: SearchProbeReport }) {
  const { capability } = report;
  return (
    <>
      <Section title={`Search verdict: ${report.verdict.toUpperCase()}`}>
        <Text style={[styles.mono, report.verdict === 'pass' ? styles.good : styles.bad]}>
          {report.summary}
        </Text>
      </Section>

      <Section title="What the shipped SQLite reports">
        <Text style={styles.mono}>
          {`sqlite_version()      : ${capability.sqliteVersion}`}
          {'\n'}
          {`matches vendored 3.50.3: ${capability.sqliteVersionMatchesVendored ? 'yes' : 'NO'}`}
          {'\n'}
          {`ENABLE_FTS5 flag      : ${capability.declaresFts5 ? 'present' : 'ABSENT'}`}
          {'\n'}
          {`ENABLE_FTS4 flag      : ${capability.declaresFts4 ? 'present' : 'absent'}`}
        </Text>
        <Text style={styles.note}>
          These four lines are the direct answer to the open question. A version other
          than 3.50.3 means the vendored amalgamation is not what linked, so the
          podspec and gradle flags do not apply.
        </Text>
      </Section>

      <Section title="Tokenizer output">
        <Text style={styles.mono}>{capability.probeTokens.join(' | ') || 'unavailable'}</Text>
        <Text style={styles.note}>
          Whether the CJK run appears as one token or several is what decides if OCR of
          non-Latin signage is retrievable under FTS5.
        </Text>
      </Section>

      <Section title="Compile options (FTS / Unicode only)">
        <Text style={styles.mono}>
          {capability.compileOptions.filter((option) => /FTS|UNICODE|ICU/i.test(option)).join('\n') ||
            'none reported'}
        </Text>
      </Section>
    </>
  );
}

function Button({
  label,
  busy,
  disabled,
  onPress,
  destructive,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        destructive && styles.buttonDestructive,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonLabel}>{busy ? 'Running…' : label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section} accessible accessibilityLabel={title}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 20, paddingTop: 60, gap: 12 },
  title: { fontSize: 22, fontWeight: '600', color: '#101010' },
  subtitle: { fontSize: 14, color: '#585858' },
  button: {
    backgroundColor: '#1f4fd8',
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonDestructive: { backgroundColor: '#a04a18' },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { backgroundColor: '#9aa8cc' },
  buttonLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  section: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#101010' },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 11,
    color: '#202020',
  },
  note: { fontSize: 12, color: '#585858', fontStyle: 'italic' },
  good: { color: '#12653a' },
  bad: { color: '#a01818' },
});
