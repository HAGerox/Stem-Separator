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
install -m 0644 "$REPOSITORY_ROOT/LICENSE" "$RESOURCE_ROOT/STEM-SEPARATOR-LICENSE.txt"
install -m 0644 "$REPOSITORY_ROOT/THIRD_PARTY_NOTICES.md" "$RESOURCE_ROOT/THIRD-PARTY-NOTICES.md"
rm -f "$BIN_ROOT/uv" "$RESOURCE_ROOT/UV-LICENSE-APACHE.txt" "$RESOURCE_ROOT/UV-LICENSE-MIT.txt"
curl --fail --location --retry 3 \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/darwin-arm64.LICENSE" \
  --output "$RESOURCE_ROOT/FFMPEG-LICENSE.txt" &
license_download_pid=$!
curl --fail --location --retry 3 \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffmpeg-darwin-arm64" \
  --output "$BIN_ROOT/ffmpeg" &
ffmpeg_download_pid=$!
curl --fail --location --retry 3 \
  "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/ffprobe-darwin-arm64" \
  --output "$BIN_ROOT/ffprobe" &
ffprobe_download_pid=$!
wait "$license_download_pid"
wait "$ffmpeg_download_pid"
wait "$ffprobe_download_pid"
echo "$FFMPEG_SHA256  $BIN_ROOT/ffmpeg" | shasum -a 256 --check
echo "$FFPROBE_SHA256  $BIN_ROOT/ffprobe" | shasum -a 256 --check
chmod 755 "$BIN_ROOT/ffmpeg" "$BIN_ROOT/ffprobe"
codesign --force --sign - "$BIN_ROOT/ffmpeg" "$BIN_ROOT/ffprobe"

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

# Wheels commonly ship test suites and bytecode caches that are not needed by
# the application. Keep runtime source, native libraries, metadata, and Torch
# headers (TorchInductor may use those), while removing only reproducible
# development/test payloads.
SITE_PACKAGES="$RUNTIME_ROOT/lib/python3.12/site-packages"
for package in numpy scipy sklearn sympy networkx numba onnx joblib; do
  if [[ -d "$SITE_PACKAGES/$package" ]]; then
    find "$SITE_PACKAGES/$package" -type d \( -name test -o -name tests \) -prune -exec rm -rf {} +
  fi
done
rm -rf \
  "$SITE_PACKAGES/Cython" \
  "$SITE_PACKAGES/cython.py" \
  "$SITE_PACKAGES/cython-"*.dist-info \
  "$RUNTIME_ROOT/bin/cygdb" \
  "$RUNTIME_ROOT/bin/cython" \
  "$RUNTIME_ROOT/bin/cythonize" \
  "$SITE_PACKAGES/torch/bin/protoc" \
  "$SITE_PACKAGES/torch/bin/protoc-"*

# The managed interpreter ships installation and Tk GUI tooling. The bundled
# runtime is already provisioned and headless, so neither is used by the app.
rm -rf \
  "$PYTHON_ROOT/lib/python3.12/ensurepip" \
  "$PYTHON_ROOT/lib/python3.12/idlelib" \
  "$PYTHON_ROOT/lib/python3.12/tkinter" \
  "$PYTHON_ROOT/lib/python3.12/turtledemo" \
  "$PYTHON_ROOT/lib/python3.12/turtle.py" \
  "$PYTHON_ROOT/lib/python3.12/site-packages/pip" \
  "$PYTHON_ROOT/lib/python3.12/site-packages/pip-"*.dist-info \
  "$PYTHON_ROOT/lib/libtcl9.0.dylib" \
  "$PYTHON_ROOT/lib/libtcl9tk9.0.dylib" \
  "$PYTHON_ROOT/lib/tcl9" \
  "$PYTHON_ROOT/lib/tcl9.0" \
  "$PYTHON_ROOT/lib/tk9.0"
find "$RUNTIME_ROOT" "$PYTHON_ROOT" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$RUNTIME_ROOT" "$PYTHON_ROOT" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

# A handful of large wheel binaries retain local symbol tables that are useful
# for debugging but not for loading or calling their exported APIs. These files
# account for nearly all available symbol savings; targeting them avoids
# spending build time stripping hundreds of small extensions. Restore an
# ad-hoc signature after each change so macOS can load it during the smoke test.
STRIP_TARGETS=(
  "$SITE_PACKAGES/torch/lib/libtorch_cpu.dylib"
  "$SITE_PACKAGES/torch/lib/libtorch_python.dylib"
  "$SITE_PACKAGES/llvmlite/binding/libllvmlite.dylib"
  "$SITE_PACKAGES/onnxruntime/capi/onnxruntime_pybind11_state.so"
  "$SITE_PACKAGES/onnxruntime/capi/"libonnxruntime.*.dylib
  "$PYTHON_ROOT/lib/libpython3.12.dylib"
)
for binary in "${STRIP_TARGETS[@]}"; do
  [[ -f "$binary" ]] || continue
  strip -x "$binary" >/dev/null 2>&1
  codesign --force --sign - "$binary" >/dev/null 2>&1
done

cat > "$BIN_ROOT/audio-separator" <<'WRAPPER'
#!/bin/sh
RESOURCE_BIN="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RESOURCE_ROOT="$(dirname -- "$RESOURCE_BIN")"
export PATH="$RESOURCE_BIN:$PATH"
export VIRTUAL_ENV="$RESOURCE_ROOT/runtime"
export PYTHONPATH="$RESOURCE_ROOT/runtime/lib/python3.12/site-packages${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/Library/Caches}/Stem Separator"
mkdir -p "$CACHE_ROOT/numba"
export NUMBA_CACHE_DIR="$CACHE_ROOT/numba"
exec "$RESOURCE_ROOT/python/bin/python3.12" "$RESOURCE_ROOT/runtime/bin/audio-separator" "$@"
WRAPPER
chmod 755 "$BIN_ROOT/audio-separator"
"$BIN_ROOT/ffmpeg" -version >/dev/null
"$BIN_ROOT/ffprobe" -version >/dev/null
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$SITE_PACKAGES" "$PYTHON_ROOT/bin/python3.12" - <<'PY'
import audio_separator
import diffq
import librosa
import numba
import numpy
import onnx2torch
import onnxruntime
import scipy
import torch
import torchvision

assert torch.backends.mps.is_built(), "The bundled PyTorch build has no Apple MPS support."
assert "CPUExecutionProvider" in onnxruntime.get_available_providers()
print(f"PyTorch {torch.__version__}; ONNX Runtime providers: {onnxruntime.get_available_providers()}")
PY
"$BIN_ROOT/audio-separator" --version
