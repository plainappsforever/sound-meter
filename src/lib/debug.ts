// Dev-build switches (V1_PLAN rule 14): debug controls exist only when APP_VARIANT is development. P4 adds the debug
// screen and deep links (synthetic source, seed data, gap injection) behind this flag.
import Constants from 'expo-constants';

export const isDevBuild: boolean = Constants.expoConfig?.extra?.appVariant === 'development';
