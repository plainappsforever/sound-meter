#!/usr/bin/env bash
# Check that the mobile toolchain is installed and usable. Prints one line per check.
cd "$(dirname "$0")/.."
source scripts/env.sh
failures=0

check() {
  local label=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    echo "ok    $label: $(echo "$output" | head -1)"
  else
    echo "FAIL  $label: $(echo "$output" | head -1)"
    failures=$((failures + 1))
  fi
}

check "Xcode selected" bash -c 'xcode-select -p | grep -q "/Xcode.*\.app/" && xcodebuild -version | head -1'
check "iOS runtime" bash -c 'xcrun simctl list runtimes | grep -m1 "^iOS"'
check "iOS simulator \"$IOS_SIMULATOR\"" bash -c 'xcrun simctl list devices available | grep -m1 -F "$IOS_SIMULATOR ("'
check "CocoaPods" pod --version
check "JDK 17" bash -c 'java -version 2>&1 | grep -m1 "\"17\."'
check "Android SDK" test -d "$ANDROID_HOME/platforms"
check "adb" bash -c 'adb version | head -1'
check "Android emulator" bash -c 'emulator -version | head -1'
check "AVD \"$ANDROID_AVD\"" bash -c 'emulator -list-avds | grep -x "$ANDROID_AVD"'
check "Node" node --version
check "npm" npm --version
check "Expo CLI" npx --no-install expo --version
check "Maestro" maestro --version
check "Watchman" watchman --version
check "Git" git --version

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All checks passed."
