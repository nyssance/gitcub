#!/bin/bash
# Compile the checked-in Icon Composer source for macOS 26+ and its legacy fallback.
# Requires full Xcode. The shared artwork lives in assets/brand/gitcub.png.
set -euo pipefail
cd "$(dirname "$0")/.."
icon_output=$(mktemp -d)
trap 'rm -rf "$icon_output"' EXIT
cp assets/brand/gitcub.png assets/brand/GitCub.icon/Assets/gitcub.png
xcrun actool assets/brand/GitCub.icon --compile "$icon_output" \
  --output-format human-readable-text \
  --output-partial-info-plist "$icon_output/Info.plist" \
  --app-icon GitCub --include-all-app-icons \
  --enable-on-demand-resources NO --development-region en \
  --target-device mac --minimum-deployment-target 26.0 --platform macosx
cp "$icon_output/Assets.car" src-tauri/icons/Assets.car
cp "$icon_output/GitCub.icns" src-tauri/icons/icon.icns
