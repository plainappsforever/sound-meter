// Development-build developer menu defaults (expo-dev-menu reads these native keys).
// Hide the floating "Dev tools" button (it covers header buttons and intercepts Maestro taps),
// skip the one-time intro sheet, and don't open the menu at launch.
// The menu stays available: shake the device, or Cmd+D (iOS Simulator) / Cmd+M (Android emulator).
const { withAndroidManifest, withInfoPlist, AndroidConfig } = require('expo/config-plugins');

const DEFAULTS = {
  EXDevMenuShowFloatingActionButton: false,
  EXDevMenuIsOnboardingFinished: true,
  EXDevMenuShowsAtLaunch: false,
};

module.exports = function withDevMenuDefaults(config) {
  config = withInfoPlist(config, (mod) => {
    Object.assign(mod.modResults, DEFAULTS);
    return mod;
  });

  return withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    for (const [name, value] of Object.entries(DEFAULTS)) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, name, String(value));
    }
    return mod;
  });
};
