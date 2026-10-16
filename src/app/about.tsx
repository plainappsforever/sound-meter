// About (SPEC F8): the honest-promise text of SPEC §4 and the privacy line. Version, sources and licences come in P4.
import Constants from 'expo-constants';
import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';

export default function AboutScreen() {
  const theme = useTheme();
  const t = useT();
  return (
    <ScrollView
      testID="about"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <ThemedText>{t('honesty.text')}</ThemedText>
      <ThemedText testID="settings-privacy">{t('privacy.text')}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {t('settings.version', {
          version: String(Constants.expoConfig?.version),
          variant: String(Constants.expoConfig?.extra?.appVariant),
        })}
      </ThemedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.three, gap: Spacing.three },
});
