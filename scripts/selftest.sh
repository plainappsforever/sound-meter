#!/usr/bin/env bash
# P3: runs one step of the dev self-test route (src/app/debug/mic-selftest.tsx) on this app's simulator/emulator and
# prints its "SELFTEST {...}" lines from Metro's log (Metro must run with output in artifacts/metro.log).
# Usage: scripts/selftest.sh <ios|android> <quick|e1|inject|interruption|lost|pull|soak|realinput|all> [minutes]
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
platform=${1:?platform}
run=${2:?step}
minutes=${3:-30}
log=artifacts/metro.log
start=$(wc -l <"$log")
url="soundmeter-dev://debug/mic-selftest?run=$run&minutes=$minutes&t=$(date +%s)" # t: a new link is never mistaken for a handled one
if [[ $platform == ios ]]; then
  xcrun simctl openurl "$(node scripts/ios-simulator.js)" "$url"
else
  adb -s "$ANDROID_SERIAL" shell am start -a android.intent.action.VIEW -d "'$url'" >/dev/null
fi
if [[ $run == soak ]]; then limit=$((minutes * 60 + 300)); else limit=600; fi
for _ in $(seq 1 "$limit"); do
  tail -n +"$((start + 1))" "$log" | grep -aq "\"step\":\"done\",\"platform\":\"$platform\"" && break
  sleep 1
done
tail -n +"$((start + 1))" "$log" | grep -a "SELFTEST" | grep -a "\"platform\":\"$platform\"" | cut -c1-${SELFTEST_CUT:-1500}
