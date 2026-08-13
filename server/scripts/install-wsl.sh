#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${STEM_SEPARATOR_INSTALL_DIR:-$HOME/.local/share/stem-separator-server/runtime}"
BIN_DIR="${STEM_SEPARATOR_BIN_DIR:-$HOME/.local/bin}"
AUDIO_SEPARATOR_COMMIT="f0dd3f07953b2712b2a05a437716ad3cbaf8cea0"

if [[ ! -r /proc/sys/kernel/osrelease ]] || ! grep -qi microsoft /proc/sys/kernel/osrelease; then
  echo "Warning: this installer is intended for Ubuntu on WSL2." >&2
fi

for command in python3 ffmpeg ffprobe; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing $command. On Ubuntu run: sudo apt update && sudo apt install -y python3 python3-venv ffmpeg" >&2
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
  torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 \
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$INSTALL_DIR/bin/python" \
  --extra-index-url https://download.pytorch.org/whl/cu128 \
  "audio-separator[gpu] @ git+https://github.com/HAGerox/python-audio-separator.git@$AUDIO_SEPARATOR_COMMIT" \
  torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 \
  audioread "librosa<0.11" "$SERVER_PACKAGE"

ln -sfn "$INSTALL_DIR/bin/stem-separator-server" "$BIN_DIR/stem-separator-server"
ln -sfn "$INSTALL_DIR/bin/stem-separator-server-update" "$BIN_DIR/stem-separator-server-update"
"$INSTALL_DIR/bin/python" -c 'import torch; print(f"Torch CUDA ready: {torch.cuda.is_available()}"); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "No CUDA device detected")'
echo "Installed. Run: stem-separator-server"
