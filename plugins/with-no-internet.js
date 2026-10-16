// Adapted from ~/Developer/meter-tracker/plugins/with-no-internet.js (D74 there; D25 here, SPEC §5, A12).
// The app has no network code: levels, reports and backups stay on the phone. Preview and production Android builds
// therefore ship WITHOUT android.permission.INTERNET; `tools:node="remove"` also strips it from library manifests during
// the manifest merge. Development builds keep it (they load JavaScript from Metro); app.config.ts registers this plugin
// only for APP_VARIANT preview/production.
// The same mechanism strips permissions release builds never use: the overlay permission of the Expo template (dev menu
// only), Firebase push (c2dm), launcher-badge permissions, POST_NOTIFICATIONS (we never ask, D16), boot/alarm permissions
// and the legacy storage permissions (the app only uses its own folders and the share sheet).
// DIFFERENCE TO METER-TRACKER: FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, RECORD_AUDIO and WAKE_LOCK are NOT
// removed — the night log runs a microphone foreground service (D16, plugins/with-mic-fgs.js in P3).
const { withAndroidManifest } = require('expo/config-plugins');

const INTERNET = 'android.permission.INTERNET';

const RELEASE_REMOVED = [
  INTERNET,
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'com.google.android.c2dm.permission.RECEIVE',
  'android.permission.READ_APP_BADGE',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
  'com.android.launcher.permission.READ_SETTINGS',
  'com.android.launcher.permission.WRITE_SETTINGS',
  'com.android.launcher.permission.INSTALL_SHORTCUT',
  'com.android.launcher.permission.UNINSTALL_SHORTCUT',
];

/** Permissions the night log needs; never removed (guarded by the plugin test). */
const KEPT = [
  'android.permission.RECORD_AUDIO',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.WAKE_LOCK',
];

function withNoInternet(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const others = (manifest['uses-permission'] ?? []).filter((p) => !RELEASE_REMOVED.includes(p.$['android:name']));
    for (const name of RELEASE_REMOVED) others.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    manifest['uses-permission'] = others;
    return cfg;
  });
}

module.exports = withNoInternet;
module.exports.RELEASE_REMOVED = RELEASE_REMOVED;
module.exports.KEPT = KEPT;
