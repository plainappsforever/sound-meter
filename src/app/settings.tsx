import Constants from 'expo-constants';
import { Link } from 'expo-router';
import { useSQLiteContext } from '@/db/provider';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/db/settings';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { applyThemePreference } from '@/lib/theme-preference';

const THEME_OPTIONS: { value: ThemePreference; label: 'theme.system' | 'theme.light' | 'theme.dark' }[] = [
  { value: 'system', label: 'theme.system' },
  { value: 'light', label: 'theme.light' },
  { value: 'dark', label: 'theme.dark' },
];

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const theme = useTheme();
  const [themePreference, setThemeState] = useState<ThemePreference>('system');
  const t = useT();

  useEffect(() => {
    getThemePreference(db).then(setThemeState);
  }, [db]);

  async function chooseTheme(value: ThemePreference) {
    setThemeState(value);
    applyThemePreference(value);
    await setThemePreference(db, value);
  }

  return (
    <ScrollView
      testID="settings-screen"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <ThemedText type="smallBold">{t('settings.appearance')}</ThemedText>
      <View style={[styles.segmented, { backgroundColor: theme.backgroundElement }]}>
        {THEME_OPTIONS.map((option) => {
          const selected = option.value === themePreference;
          return (
            <Pressable
              key={option.value}
              testID={`theme-${option.value}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => chooseTheme(option.value)}
              style={[styles.segment, selected && { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type={selected ? 'smallBold' : 'small'}>{t(option.label)}</ThemedText>
            </Pressable>
          );
        })}
      </View>

      <Link href="/about" asChild>
        <Pressable testID="open-about" accessibilityRole="button" style={styles.section}>
          <ThemedText themeColor="tint">{t('settings.about')}</ThemedText>
        </Pressable>
      </Link>

      <ThemedText type="small" themeColor="textSecondary" style={styles.section}>
        {t('settings.version', {
          version: String(Constants.expoConfig?.version),
          variant: String(Constants.expoConfig?.extra?.appVariant),
        })}
      </ThemedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  section: {
    marginTop: Spacing.four,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: Spacing.one,
  },
  segment: {
    flex: 1,
    minHeight: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
