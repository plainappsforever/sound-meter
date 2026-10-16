# Decibel

Night noise log and sound level meter. Offline, no ads, no account.

A night noise log you can hand over: start it before bed, and in the morning see each disturbance above the room's own background (time, duration, how loud), label it and share a PDF or CSV protocol with the measured levels (a phone estimate, not a calibrated meter). A live sound level meter is included.

**Get it:** [GitHub Releases](https://github.com/plainappsforever/sound-meter/releases) ·
[Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/plainappsforever/sound-meter)

**Status:** in development, first release pending.

## Our promise

**Free, no ads, no tracking, no accounts.** This app keeps your data on your phone. It has no analytics, no crash
reporter, no advertising SDK and no sign-in. The Android release build has no INTERNET permission at all. We will not sell this app or this project to a company
that changes any of this.

Why we write it down: in 2023 a popular open-source Android suite was sold to an ad-funded app company and its store
listings started saying "Contains ads"; its community had to fork it to keep a clean version. The source code of
Decibel is published under GPL-3.0, so if this promise were ever broken, anyone could continue the last
version that kept it.

## What it does

This app is in development. The full feature list comes with the first release.

## Privacy

- All data is stored locally (SQLite in the app's private storage). Nothing is uploaded.
- Files leave the phone only when you share or export them yourself.
- Privacy policy: published with the first release

## Build from source

You need: **Node.js 22 LTS** (the React Native version used here accepts `^20.19.4 || ^22.13.0 || ^24.3.0`), npm,
and git. The app is an [Expo](https://expo.dev) (SDK 57) / React Native app; the native `android/` and `ios/` folders
are generated from `app.config.ts` and are not in the repository.

```sh
git clone https://github.com/plainappsforever/sound-meter.git
cd sound-meter
npm ci
npm run verify          # typecheck + lint + all unit tests
```

### Android (Linux, macOS or Windows)

Needs JDK 17 and the Android SDK (Android Studio installs both; set `ANDROID_HOME`).

```sh
export APP_VARIANT=production
npx expo prebuild --platform android
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# APK: android/app/build/outputs/apk/release/ (signed with the debug key unless you configure your own key)
```

`APP_VARIANT` selects the app id and name (`development`, `preview`, `production`; see `app.config.ts`).
Builds made this way are signed with your key, not ours, so they cannot update an installed store version.

### iOS (macOS only)

Needs Xcode (26 or newer) and CocoaPods.

```sh
export APP_VARIANT=production
npx expo prebuild --platform ios
npx expo run:ios --configuration Release        # runs on the iOS Simulator
```

For a real iPhone, open `ios/*.xcworkspace` in Xcode, choose your own team under *Signing & Capabilities*
and change the bundle identifier. There is no sideloading store for iOS; the App Store build is ours.

## Verifying a release

Every GitHub release lists SHA-256 checksums (`SHA256SUMS.txt`) and the APKs are signed with one key per app.
Certificate SHA-256 fingerprint: `not yet published on Android`

## How this app was made

Decibel was written with substantial help from an AI coding assistant (Claude Code), directed, reviewed and
tested by the maintainer. We say this openly because some stores and users care about it.

## Licence

Copyright (C) 2026 Farija Retkoceri

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, version 3 (GPL-3.0-only). See [LICENSE](LICENSE).
Third-party components keep their own licences (see `LICENSES/` and the app's licences screen where present).
Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
