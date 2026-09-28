import { useSQLiteContext, SQLiteProvider } from 'expo-sqlite';
import { Suspense, useEffect } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { initDatabase } from './src/db/database.ts';

function AppShell(): React.ReactElement {
  const db = useSQLiteContext();

  useEffect(() => {
    // Apply connection pragmas and run pending migrations on first render.
    // initDatabase is idempotent — a current database performs one read and no writes.
    initDatabase(db).catch((err: unknown) => {
      // Surface migration failures loudly in development; in production the app
      // should show an error screen rather than silently failing.
      console.error('Database initialization failed:', err);
    });
  }, [db]);

  // Phases 5–9 replace this placeholder with the real navigator.
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Photo Archive</Text>
    </View>
  );
}

export default function App(): React.ReactElement {
  return (
    <SQLiteProvider databaseName="photo-archive.db" useSuspense>
      <Suspense fallback={<View style={styles.container} />}>
        <AppShell />
      </Suspense>
    </SQLiteProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  text: { color: '#fff', fontSize: 18 },
});
