#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${STEM_SEPARATOR_INSTALL_DIR:-$HOME/.local/share/stem-separator-server/runtime}"
BIN_DIR="${STEM_SEPARATOR_BIN_DIR:-$HOME/.local/bin}"
AUDIO_SEPARATOR_COMMIT="e66045e5f0a06206d9ea5062cc7dd53df22d38c0"

if [[ ! -r /proc/sys/kernel/osrelease ]] || ! grep -qi microsoft /proc/sys/kernel/osrelease; then
  echo "Warning: this installer is intended for Ubuntu on WSL2." >&2
fi

for command in python3 ffmpeg ffprobe cc; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing $command. On Ubuntu run: sudo apt update && sudo apt install -y build-essential python3 python3-dev python3-venv ffmpeg" >&2
    exit 1
  fi
done

if ! command -v uv >/dev/null 2>&1; then
  echo "Missing uv. Install it from https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

SERVER_PACKAGE="$SERVER_DIR"
if ! [[ -f "$SERVER_DIR/pyproject.toml" ]]; then
  SERVER_PACKAGE="$(find "$SCRIPT_DIR" -maxdepth 1 -name 'stem_separator_server-*.whl' -print -quit)"
  if [[ -z "$SERVER_PACKAGE" ]]; then
    echo "Place the server wheel beside this installer, or run it from the source tree." >&2
    exit 1
  fi
fi

mkdir -p "$BIN_DIR"
uv venv --python 3.12 --allow-existing "$INSTALL_DIR"
uv pip install --python "$INSTALL_DIR/bin/python" \
  torch==2.8.0 torchvision==0.23.0 \
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$INSTALL_DIR/bin/python" \
  --extra-index-url https://download.pytorch.org/whl/cu128 \
  "audio-separator[gpu] @ git+https://github.com/HAGerox/python-audio-separator.git@$AUDIO_SEPARATOR_COMMIT" \
  torch==2.8.0 torchvision==0.23.0 \
  "onnxruntime-gpu>=1.21,<1.27" audioread "librosa<0.11" "$SERVER_PACKAGE"

ln -sfn "$INSTALL_DIR/bin/stem-separator-server" "$BIN_DIR/stem-separator-server"
ln -sfn "$INSTALL_DIR/bin/stem-separator-server-update" "$BIN_DIR/stem-separator-server-update"
"$INSTALL_DIR/bin/python" - <<'PY'
import onnxruntime
import torch

assert torch.cuda.is_available(), "PyTorch cannot access an NVIDIA GPU. Check the Windows NVIDIA driver and WSL GPU passthrough."
device = torch.cuda.get_device_name(0)
value = (torch.ones(4, device="cuda") * 2).sum().item()
assert value == 8
onnxruntime.preload_dlls(directory="")
providers = onnxruntime.get_available_providers()
assert "CUDAExecutionProvider" in providers, f"ONNX Runtime CUDA provider is unavailable: {providers}"
print(f"Torch CUDA ready: {device} (CUDA {torch.version.cuda})")
print(f"ONNX Runtime providers: {providers}")
PY
echo "Installed. Run: stem-separator-server"
