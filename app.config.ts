import type { ConfigContext, ExpoConfig } from 'expo/config';

// One codebase, three installable variants that can sit side by side on a device.
// Select with APP_VARIANT (set by scripts/native.sh and eas.json).
const VARIANTS = {
  // Bundle id prefix com.plainapps (owner-approved 2026-10-15, D14). Store name is still open (SPEC §20 Q1).
  development: { name: 'Decibel Dev', id: 'com.plainapps.soundmeter.dev', scheme: 'soundmeter-dev' },
  preview: { name: 'Decibel Preview', id: 'com.plainapps.soundmeter.preview', scheme: 'soundmeter-preview' },
  production: { name: 'Decibel', id: 'com.plainapps.soundmeter', scheme: 'soundmeter' },
} as const;

type Variant = keyof typeof VARIANTS;

const variant = (process.env.APP_VARIANT ?? 'development') as Variant;
if (!(variant in VARIANTS)) {
  throw new Error(`Unknown APP_VARIANT "${variant}". Use development, preview or production.`);
}
const { name, id, scheme } = VARIANTS[variant];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: 'sound-meter',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: id,
    icon: './assets/expo.icon',
  },
  android: {
    package: id,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#208AEF', image: './assets/images/splash-icon.png', imageWidth: 76 }],
    'expo-sqlite',
    // expo-notifications stays installed (owner rule: never uninstall) but is excluded from autolinking in package.json:
    // the app never asks for notification permission (SPEC §3.1, D16). The Android logging notification comes from the
    // microphone foreground service of modules/mic-pcm (P3).
    'expo-localization',
    // Dev builds reopen the last Metro server directly, so Maestro can launch them unattended.
    ['expo-dev-client', { launchMode: 'most-recent' }],
    './plugins/with-dev-menu-defaults.js',
    // Microphone (P3, modules/mic-pcm): iOS purpose string + UIBackgroundModes audio (D15); Android microphone
    // foreground service + FGS permissions (D16).
    './plugins/with-mic-fgs.js',
    // Release builds have no network permission (SPEC §5, A12). Dev builds keep INTERNET for Metro.
    ...(variant === 'development' ? [] : ['./plugins/with-no-internet.js' as const]),
    // Xcode 27 / iOS 27 SDK: apps without the UIScene lifecycle trap at launch. SDK 57 opt-in (expo >= 57.0.23,
    // expo-build-properties >= 57.0.20); SDK 58+ has it by default, then remove this line. See docs/DECISIONS.md D9.
    ['expo-build-properties', { ios: { enableSceneSupport: true } }],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appVariant: variant,
  },
});
