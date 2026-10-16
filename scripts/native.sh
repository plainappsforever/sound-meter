#!/usr/bin/env bash
# Build, install and launch the app on the default simulator/emulator.
# Usage: scripts/native.sh <ios|android> [development|preview|production]
#   development: Debug build that loads JavaScript from Metro (start it with `npm run dev`).
#   preview/production: Release build with JavaScript embedded; runs without Metro.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

platform=${1:?Usage: native.sh <ios|android> [development|preview|production]}
variant=${2:-development}
export APP_VARIANT=$variant

# ios/ and android/ are generated from app.config.ts (never edit them by hand).
# Regenerate when the variant, app config or native dependencies change.
# No --clean by default: it deletes ios/ and android/, which only the owner may decide. Opt in with PREBUILD_FLAGS=--clean.
marker="$platform/.generated-for"
stamp="$variant $( (cat app.config.ts package-lock.json plugins/*.js; find modules -type f \( -name "*.swift" -o -name "*.podspec" -o -name "*.json" -o -name "*.gradle" -o -name "AndroidManifest.xml" \) -not -path "*/build/*" | sort) | shasum | cut -c1-12)"
if [[ ! -f $marker || "$(cat "$marker")" != "$stamp" ]]; then
  # shellcheck disable=SC2086 # PREBUILD_FLAGS is intentionally word-split
  npx expo prebuild ${PREBUILD_FLAGS:---no-clean} --platform "$platform"
  echo "$stamp" >"$marker"
fi
unset SDKROOT # env.sh sets it for prebuild/pod install only; xcodebuild must pick its own iOS SDK

device=$(scripts/boot.sh "$platform")

if [[ $platform == ios ]]; then
  args=(--device "$device")
  # --no-bundler and --port are mutually exclusive on this Expo CLI (print-cost): development attaches to the
  # already-running Metro (npm run dev) on our own port; release builds embed JS and need no bundler.
  if [[ $variant == development ]]; then
    args+=(--port "$METRO_PORT")
  else
    args+=(--no-bundler --configuration Release)
  fi
  mkdir -p artifacts
  set +e
  npx expo run:ios "${args[@]}" 2>&1 | tee artifacts/run-ios.log
  status=${PIPESTATUS[0]}
  set -e
  # Expo's final "focus Simulator window" step needs macOS Automation permission; the app is already launched.
  if [[ $status -ne 0 ]] && grep -q "› Opening on" artifacts/run-ios.log && grep -q "System Events" artifacts/run-ios.log; then
    echo "App installed and opened (ignored Simulator window-focus error)."
    status=0
  fi
  [[ $status -eq 0 ]] || exit "$status"
else
  # expo resolves --device by AVD NAME (a serial gives "Could not find device with name"); ANDROID_SERIAL from
  # env.sh still pins adb/Gradle to our emulator, so a plugged-in phone never gets an install.
  args=(--device "$ANDROID_AVD")
  if [[ $variant == development ]]; then
    args+=(--port "$METRO_PORT")
  else
    args+=(--no-bundler --variant release)
  fi
  npx expo run:android "${args[@]}"
fi

# Dev builds: point the dev client at THIS app's Metro port (other apps run Metro on other ports).
if [[ $variant == development ]]; then
  scheme=$(npx expo config --json --type public | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).scheme)')
  url="$scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$METRO_PORT"
  if [[ $platform == ios ]]; then
    xcrun simctl openurl "$device" "$url" >/dev/null 2>&1 || true
  else
    adb -s "$device" shell am start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1 || true
  fi
fi
