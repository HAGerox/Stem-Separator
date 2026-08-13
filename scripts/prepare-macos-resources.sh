#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_ROOT="$REPOSITORY_ROOT/src-tauri/resources"
BIN_ROOT="$RESOURCE_ROOT/bin"
RUNTIME_ROOT="$RESOURCE_ROOT/runtime"
PYTHON_ROOT="$RESOURCE_ROOT/python"
AUDIO_SEPARATOR_COMMIT="dccdbe5fafa8d2c4274ebf76a3ff1c27bf0c86d3"
FFMPEG_RELEASE="b6.1.1"
FFMPEG_SHA256="a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584"
FFPROBE_SHA256="bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The macOS resource bundle must be prepared on Apple Silicon." >&2
  exit 1
fi
for command in curl git uv; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

mkdir -p "$BIN_ROOT"
curl --fail --location --retry 3 \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/darwin-arm64.LICENSE" \
  --output "$RESOURCE_ROOT/FFMPEG-LICENSE.txt"
curl --fail --location --retry 3 \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffmpeg-darwin-arm64" \
  --output "$BIN_ROOT/ffmpeg"
curl --fail --location --retry 3 \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffprobe-darwin-arm64" \
  --output "$BIN_ROOT/ffprobe"
echo "$FFMPEG_SHA256  $BIN_ROOT/ffmpeg" | shasum -a 256 --check
echo "$FFPROBE_SHA256  $BIN_ROOT/ffprobe" | shasum -a 256 --check
cp "$(command -v uv)" "$BIN_ROOT/uv"
curl --fail --location --retry 3 \
  "https://raw.githubusercontent.com/astral-sh/uv/main/LICENSE-APACHE" \
  --output "$RESOURCE_ROOT/UV-LICENSE-APACHE.txt"
curl --fail --location --retry 3 \
  "https://raw.githubusercontent.com/astral-sh/uv/main/LICENSE-MIT" \
  --output "$RESOURCE_ROOT/UV-LICENSE-MIT.txt"
chmod 755 "$BIN_ROOT/ffmpeg" "$BIN_ROOT/ffprobe" "$BIN_ROOT/uv"
codesign --force --sign - "$BIN_ROOT/ffmpeg" "$BIN_ROOT/ffprobe" "$BIN_ROOT/uv"

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT
WHEEL_ROOT="$BUILD_ROOT/wheels"
mkdir -p "$WHEEL_ROOT"
git clone --filter=blob:none --no-checkout https://github.com/HAGerox/python-audio-separator.git "$BUILD_ROOT/python-audio-separator"
git -C "$BUILD_ROOT/python-audio-separator" checkout "$AUDIO_SEPARATOR_COMMIT"
uv build --wheel --out-dir "$WHEEL_ROOT" "$BUILD_ROOT/python-audio-separator"
PAS_WHEEL="$(find "$WHEEL_ROOT" -maxdepth 1 -name 'audio_separator-*.whl' -print -quit)"
if [[ -z "$PAS_WHEEL" ]]; then
  echo "The pinned PAS fork did not produce a wheel." >&2
  exit 1
fi

if [[ -e "$RUNTIME_ROOT" ]]; then
  if [[ ! -f "$RUNTIME_ROOT/pyvenv.cfg" ]]; then
    echo "Refusing to replace unexpected runtime path: $RUNTIME_ROOT" >&2
    exit 1
  fi
  rm -rf "$RUNTIME_ROOT"
fi
if [[ -e "$PYTHON_ROOT" ]]; then
  if [[ ! -x "$PYTHON_ROOT/bin/python3.12" ]]; then
    echo "Refusing to replace unexpected Python path: $PYTHON_ROOT" >&2
    exit 1
  fi
  rm -rf "$PYTHON_ROOT"
fi
if [[ -e "$RESOURCE_ROOT/python-install" ]]; then
  echo "Refusing to replace unexpected Python staging path: $RESOURCE_ROOT/python-install" >&2
  exit 1
fi
UV_PYTHON_INSTALL_DIR="$RESOURCE_ROOT/python-install" uv python install 3.12.13 --no-bin
MANAGED_PYTHON="$(UV_PYTHON_INSTALL_DIR="$RESOURCE_ROOT/python-install" uv python find 3.12.13)"
MANAGED_PYTHON_ROOT="$(cd -- "$(dirname -- "$MANAGED_PYTHON")/.." && pwd -P)"
mv "$MANAGED_PYTHON_ROOT" "$PYTHON_ROOT"
rm -rf "$RESOURCE_ROOT/python-install"
uv venv --python "$PYTHON_ROOT/bin/python3.12" --relocatable "$RUNTIME_ROOT"
uv pip install --python "$RUNTIME_ROOT/bin/python" \
  "$PAS_WHEEL" onnxruntime audioread "librosa<0.11"

cat > "$BIN_ROOT/audio-separator" <<'WRAPPER'
#!/bin/sh
RESOURCE_BIN="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RESOURCE_ROOT="$(dirname -- "$RESOURCE_BIN")"
export PATH="$RESOURCE_BIN:$PATH"
export VIRTUAL_ENV="$RESOURCE_ROOT/runtime"
export PYTHONPATH="$RESOURCE_ROOT/runtime/lib/python3.12/site-packages${PYTHONPATH:+:$PYTHONPATH}"
exec "$RESOURCE_ROOT/python/bin/python3.12" "$RESOURCE_ROOT/runtime/bin/audio-separator" "$@"
WRAPPER
chmod 755 "$BIN_ROOT/audio-separator"
"$BIN_ROOT/ffmpeg" -version >/dev/null
"$BIN_ROOT/ffprobe" -version >/dev/null
"$BIN_ROOT/audio-separator" --version
