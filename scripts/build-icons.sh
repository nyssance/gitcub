#!/bin/bash
# One artwork source for the WebView, Tauri PNG/ICO, and native macOS catalog.
set -euo pipefail
cd "$(dirname "$0")/.."
icon_output=$(mktemp -d)
trap 'rm -rf "$icon_output"' EXIT
bun tauri icon assets/brand/gitcub.png --output "$icon_output"
for icon in "$icon_output"/*.png "$icon_output"/*.ico "$icon_output"/*.icns; do
  cp "$icon" src-tauri/icons/
done
cp "$icon_output/icon.png" public/icon.png
if [[ "$(uname -s)" == Darwin ]]; then
  bash scripts/build-macos-icon.sh
fi
