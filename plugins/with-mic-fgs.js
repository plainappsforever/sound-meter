// Microphone capture config for modules/mic-pcm (P3; SPEC §5, §13; D15, D16).
// Android: the microphone foreground service of the night log — the service entry
// (expo.modules.micpcm.MicCaptureService, foregroundServiceType="microphone") and FOREGROUND_SERVICE +
// FOREGROUND_SERVICE_MICROPHONE. RECORD_AUDIO comes from the module's own manifest. No WAKE_LOCK: the P3 spike decides
// (D16), and no POST_NOTIFICATIONS (D16).
// iOS: NSMicrophoneUsageDescription (SPEC §13 text) and UIBackgroundModes "audio" (the user-started night log keeps
// measuring with the screen locked; D15).
// The module's manifest deliberately does NOT declare the service, so another app reusing the module (tuner) does not
// inherit a Play foreground-service declaration.
const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const SERVICE = 'expo.modules.micpcm.MicCaptureService';
const PERMISSIONS = ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MICROPHONE'];
const DEFAULT_PURPOSE =
  'Decinote measures sound levels with the microphone to show and log noise. No audio is recorded or stored — only the levels.';

function withMicFgs(config, props = {}) {
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const perms = manifest['uses-permission'] ?? [];
    for (const name of PERMISSIONS)
      if (!perms.some((p) => p.$['android:name'] === name)) perms.push({ $: { 'android:name': name } });
    manifest['uses-permission'] = perms;
    const app = manifest.application?.[0];
    if (app) {
      const services = (app.service ?? []).filter((s) => s.$['android:name'] !== SERVICE);
      services.push({
        $: { 'android:name': SERVICE, 'android:exported': 'false', 'android:foregroundServiceType': 'microphone' },
      });
      app.service = services;
    }
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSMicrophoneUsageDescription = props.microphonePermission ?? DEFAULT_PURPOSE;
    const modes = new Set(cfg.modResults.UIBackgroundModes ?? []);
    modes.add('audio');
    cfg.modResults.UIBackgroundModes = [...modes];
    return cfg;
  });
  return config;
}

module.exports = withMicFgs;
module.exports.SERVICE = SERVICE;
module.exports.PERMISSIONS = PERMISSIONS;
