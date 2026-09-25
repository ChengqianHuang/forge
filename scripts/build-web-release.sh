#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT_DIR="${1:-$ROOT/dist}"
STAGE="$(mktemp -d -t forge-web-release.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

npm --prefix "$ROOT/desktop" run build
mkdir -p "$STAGE/forge-web-$VERSION/desktop" "$STAGE/forge-web-$VERSION/pi/packages"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$STAGE/forge-web-$VERSION/"
cp "$ROOT/docs/WEB-RELEASE.md" "$STAGE/forge-web-$VERSION/INSTALL.md"
cp "$ROOT/pi/LICENSE" "$STAGE/forge-web-$VERSION/pi/"
cp -R "$ROOT/src" "$STAGE/forge-web-$VERSION/"
cp -R "$ROOT/desktop/dist" "$STAGE/forge-web-$VERSION/desktop/"

for package in agent ai coding-agent client protocol telemetry tui; do
  mkdir -p "$STAGE/forge-web-$VERSION/pi/packages/$package"
  cp "$ROOT/pi/packages/$package/package.json" "$STAGE/forge-web-$VERSION/pi/packages/$package/"
  cp -R "$ROOT/pi/packages/$package/dist" "$STAGE/forge-web-$VERSION/pi/packages/$package/"
done

mkdir -p "$OUT_DIR"
tar -C "$STAGE" -czf "$OUT_DIR/forge-web-$VERSION.tar.gz" "forge-web-$VERSION"
echo "$OUT_DIR/forge-web-$VERSION.tar.gz"
