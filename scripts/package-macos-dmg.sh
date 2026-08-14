#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <app-path> <output-dmg>" >&2
  exit 2
fi

APP_PATH="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
OUTPUT_DIR="$(cd -- "$(dirname -- "$2")" && pwd)"
OUTPUT_DMG="$OUTPUT_DIR/$(basename -- "$2")"

if [[ ! -d "$APP_PATH" || "$APP_PATH" != *.app ]]; then
  echo "App bundle not found: $APP_PATH" >&2
  exit 1
fi

STAGING_ROOT="$(mktemp -d)"
cleanup() {
  case "$STAGING_ROOT" in
    /private/tmp/*|/tmp/*|/var/folders/*) rm -rf -- "$STAGING_ROOT" ;;
    *) echo "Refusing to remove unexpected staging path: $STAGING_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT

ditto "$APP_PATH" "$STAGING_ROOT/$(basename -- "$APP_PATH")"
ln -s /Applications "$STAGING_ROOT/Applications"
hdiutil create \
  -volname "Stem Separator" \
  -srcfolder "$STAGING_ROOT" \
  -format ULFO \
  -ov \
  "$OUTPUT_DMG"

echo "$OUTPUT_DMG"
