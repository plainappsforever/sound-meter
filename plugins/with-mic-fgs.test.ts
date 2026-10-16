/**
 * @jest-environment node
 */
// The microphone FGS entry + permissions (Android) and the purpose string + audio background mode (iOS), P3.
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) => {
    action({ ...config, modResults: { manifest: config.manifest } });
    return config;
  },
  withInfoPlist: (config: { plist: unknown }, action: (c: { modResults: unknown }) => unknown) => {
    action({ ...config, modResults: config.plist });
    return config;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withMicFgs = require('./with-mic-fgs');

type Node = { $: Record<string, string> };

describe('with-mic-fgs', () => {
  it('adds the microphone service and FGS permissions once, and the iOS purpose string + audio background mode', () => {
    const manifest: { $: Record<string, string>; 'uses-permission': Node[]; application: { service?: Node[] }[] } = {
      $: {},
      'uses-permission': [{ $: { 'android:name': 'android.permission.FOREGROUND_SERVICE' } }],
      application: [{}],
    };
    const plist: Record<string, unknown> = { UIBackgroundModes: ['audio'] };
    withMicFgs({ manifest, plist });
    withMicFgs({ manifest, plist }); // idempotent
    const perms = manifest['uses-permission'].map((p) => p.$['android:name']);
    expect(perms.sort()).toEqual(['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MICROPHONE']);
    expect(manifest.application[0].service).toEqual([
      {
        $: {
          'android:name': 'expo.modules.micpcm.MicCaptureService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'microphone',
        },
      },
    ]);
    expect(plist.UIBackgroundModes).toEqual(['audio']);
    expect(plist.NSMicrophoneUsageDescription).toMatch(/No audio is recorded or stored/);
  });
});
