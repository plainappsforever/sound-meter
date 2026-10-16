import { useMemo, useSyncExternalStore } from 'react';

import { getLanguage, makeT, subscribeLanguage, type Language } from '@/i18n';

/** The current UI language; re-renders the component when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage);
}

/**
 * t() bound to the current language. Its identity changes with the language on purpose: the React Compiler memoises
 * `t('key')` results on the identity of `t`, so a stable module-level `t` keeps showing the old language after a switch.
 * Never read `getLanguage()` during render in a component; use `useLanguage()`/`useT()`.
 */
export function useT() {
  const language = useLanguage();
  return useMemo(() => makeT(language), [language]);
}
