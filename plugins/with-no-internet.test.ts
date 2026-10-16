/**
 * @jest-environment node
 */
// Adapted from meter-tracker. Release builds lose INTERNET and unused permissions (SPEC §5, A12, D25) but KEEP the
// microphone foreground-service permissions the night log needs (D16).
jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: { manifest: unknown }, action: (c: { modResults: { manifest: unknown } }) => unknown) =>
    action({ ...config, modResults: { manifest: config.manifest } }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withNoInternet = require('./with-no-internet');

type Perm = { $: Record<string, string> };

describe('with-no-internet', () => {
  it('removes INTERNET and notification/boot permissions, keeps microphone and foreground-service permissions', () => {
    const manifest: { $: Record<string, string>; 'uses-permission': Perm[] } = {
      $: {},
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.RECORD_AUDIO' } },
        { $: { 'android:name': 'android.permission.FOREGROUND_SERVICE' } },
        { $: { 'android:name': 'android.permission.FOREGROUND_SERVICE_MICROPHONE' } },
        { $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } },
        { $: { 'android:name': 'android.permission.VIBRATE' } },
      ],
    };
    withNoInternet({ manifest });
    const names = manifest['uses-permission'].map((p) => `${p.$['android:name']}|${p.$['tools:node'] ?? ''}`);
    expect(names).toContain('android.permission.INTERNET|remove');
    expect(names).toContain('android.permission.POST_NOTIFICATIONS|remove');
    expect(names).toContain('android.permission.RECEIVE_BOOT_COMPLETED|remove');
    expect(names).toContain('android.permission.RECORD_AUDIO|');
    expect(names).toContain('android.permission.FOREGROUND_SERVICE|');
    expect(names).toContain('android.permission.FOREGROUND_SERVICE_MICROPHONE|');
    expect(names).toContain('android.permission.VIBRATE|');
    for (const kept of withNoInternet.KEPT) expect(withNoInternet.RELEASE_REMOVED).not.toContain(kept);
    expect(names.filter((n) => n.startsWith('android.permission.INTERNET'))).toHaveLength(1);
    expect(manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });
});
