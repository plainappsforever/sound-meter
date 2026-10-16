import { Appearance } from 'react-native';

import type { ThemePreference } from '@/db/settings';

/** Overrides the OS appearance for this app; useColorScheme() follows automatically. */
export function applyThemePreference(theme: ThemePreference) {
  Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme);
}
