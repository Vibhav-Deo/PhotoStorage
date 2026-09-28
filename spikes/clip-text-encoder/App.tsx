/**
 * Spike UI for photo-archive task 0.1.
 *
 * Intentionally plain. The output is meant to be read off the screen and pasted
 * into the design's open questions section, so everything that matters is text.
 */

import { useCallback, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import {
  probeDevice,
  type DeviceProbeOutcome,
  type ProbeProgress,
} from './src/deviceProbe.ts';

export default function App() {
  const [progress, setProgress] = useState<ProbeProgress>({
    stage: 'idle',
    detail: 'Not started',
  });
  const [outcome, setOutcome] = useState<DeviceProbeOutcome | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setOutcome(null);
    try {
      setOutcome(await probeDevice(setProgress));
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>CLIP text encoder spike</Text>
        <Text style={styles.subtitle}>
          {Platform.OS} {String(Platform.Version)}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run the CLIP cross-modal probe"
          accessibilityState={{ disabled: running, busy: running }}
          disabled={running}
          onPress={run}
          style={({ pressed }) => [
            styles.button,
            running && styles.buttonDisabled,
            pressed && !running && styles.buttonPressed,
          ]}
        >
          <Text style={styles.buttonLabel}>
            {running ? 'Running…' : 'Run probe'}
          </Text>
        </Pressable>

        <Section title="Progress">
          <Text style={styles.mono} accessibilityLiveRegion="polite">
            {progress.stage}
            {progress.downloadProgress !== undefined
              ? ` · ${Math.round(progress.downloadProgress * 100)}%`
              : ''}
            {'\n'}
            {progress.detail}
          </Text>
        </Section>

        {outcome ? <Outcome outcome={outcome} /> : null}
      </ScrollView>
    </View>
  );
}

function Outcome({ outcome }: { outcome: DeviceProbeOutcome }) {
  const { report, failure, timings, textModelInputShapes } = outcome;
  return (
    <>
      {failure ? (
        <Section title="Failure">
          <Text style={[styles.mono, styles.bad]}>
            stage: {failure.stage}
            {'\n'}
            {failure.message}
          </Text>
          {failure.looksLikeInputContractMismatch ? (
            <Text style={styles.note}>
              This error mentions inputs or shapes. The published model config
              declares the text method as one [1, 77] tensor, while the
              runtime&apos;s generic text runner passes two dynamic-length
              tensors. That mismatch is the most likely cause. Fall back to an
              ONNX Runtime text encoder.
            </Text>
          ) : null}
        </Section>
      ) : null}

      {report ? (
        <Section title={`Verdict: ${report.verdict.toUpperCase()}`}>
          <Text
            style={[
              styles.mono,
              report.verdict === 'pass' ? styles.good : styles.bad,
            ]}
          >
            {report.summary}
          </Text>
          <Text style={styles.mono}>
            {'\n'}image dim {report.imageDim} · text dim {report.textDim}
          </Text>
          <Text style={styles.mono}>
            {'\n'}
            {report.perCaption
              .map(
                (row) =>
                  `${row.rankOfCorrectImage === 1 ? 'ok  ' : 'MISS'} rank ${
                    row.rankOfCorrectImage
                  }  cos ${row.matchedCosine.toFixed(4)}  ${row.caption}`
              )
              .join('\n')}
          </Text>
        </Section>
      ) : null}

      <Section title="Text model declared input shapes">
        <Text style={styles.mono}>
          {textModelInputShapes
            ? textModelInputShapes
                .map((shape, i) => `input ${i}: [${shape.join(', ')}]`)
                .join('\n')
            : 'unavailable'}
        </Text>
      </Section>

      <Section title="Timings (ms)">
        <Text style={styles.mono}>
          {`image encoder load : ${fmt(timings.imageEncoderLoadMs)}
text encoder load  : ${fmt(timings.textEncoderLoadMs)}
mean image embed   : ${fmt(timings.meanImageEmbedMs)}
mean text embed    : ${fmt(timings.meanTextEmbedMs)}`}
        </Text>
        <Text style={styles.note}>
          Mean text embed is the number Requirement 5.3 cares about: it is paid
          once per query, before any vector scanning.
        </Text>
      </Section>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section} accessible accessibilityLabel={title}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function fmt(value: number | undefined): string {
  return value === undefined ? '—' : Math.round(value).toString();
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 20, paddingTop: 60, gap: 16 },
  title: { fontSize: 22, fontWeight: '600', color: '#101010' },
  subtitle: { fontSize: 14, color: '#585858' },
  button: {
    backgroundColor: '#1f4fd8',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonPressed: { backgroundColor: '#1740b0' },
  buttonDisabled: { backgroundColor: '#9aa8cc' },
  buttonLabel: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
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
    fontSize: 12,
    color: '#202020',
  },
  note: { fontSize: 12, color: '#585858', fontStyle: 'italic' },
  good: { color: '#12653a' },
  bad: { color: '#a01818' },
});
