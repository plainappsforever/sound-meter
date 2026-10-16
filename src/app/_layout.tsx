import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useColorScheme } from 'react-native';

import { DatabaseProvider } from '@/db/provider';
import { migrate } from '@/db/migrations';
import { getThemePreference } from '@/db/settings';
import { useT } from '@/hooks/use-t';
import { applyThemePreference } from '@/lib/theme-preference';

async function initDatabase(db: SQLiteDatabase) {
  await migrate(db);
  applyThemePreference(await getThemePreference(db));
}

export default function RootLayout() {
  return (
    <DatabaseProvider onInit={initDatabase}>
      <Navigator />
    </DatabaseProvider>
  );
}

function Navigator() {
  const scheme = useColorScheme();
  const t = useT();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: t('meter.title') }} />
        <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
        <Stack.Screen name="about" options={{ title: t('about.title') }} />
      </Stack>
    </ThemeProvider>
  );
}
