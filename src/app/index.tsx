// P1 placeholder for the Home meter (SPEC F1). The live display, permission card and controls come in P4, fed by the
// capture module of P3. testIDs follow SPEC §10 so later flows can keep them.
import { Link, Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';

export default function MeterScreen() {
  const theme = useTheme();
  const t = useT();
  return (
    <>
      <Stack.Screen
        options={{
          title: t('meter.title'),
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable testID="open-settings" accessibilityLabel={t('open.settings')} hitSlop={8}>
                <ThemedText themeColor="tint">{t('open.settings')}</ThemedText>
              </Pressable>
            </Link>
          ),
        }}
      />
      <ScrollView
        testID="meter-screen"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic">
        <ThemedText testID="meter-unit" themeColor="textSecondary">
          {t('meter.unit', { weighting: 'A', timeWeighting: t('tw.F') })}
        </ThemedText>
        <ThemedText testID="calibration-chip" themeColor="textSecondary">
          {t('calib.notCalibrated')}
        </ThemedText>
        <ThemedText>{t('meter.placeholder')}</ThemedText>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.three, gap: Spacing.two },
});
