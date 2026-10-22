#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${STEM_SEPARATOR_INSTALL_DIR:-$HOME/.local/share/stem-separator-server/runtime}"
BIN_DIR="${STEM_SEPARATOR_BIN_DIR:-$HOME/.local/bin}"
REVISION_FILE="$SCRIPT_DIR/audio-separator-revision.txt"
if [[ ! -f "$REVISION_FILE" ]]; then
  REVISION_FILE="$SERVER_DIR/../audio-separator-revision.txt"
fi
AUDIO_SEPARATOR_COMMIT="$(tr -d '[:space:]' < "$REVISION_FILE")"

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
uv venv --python 3.12.15 --clear "$INSTALL_DIR"
uv pip install --python "$INSTALL_DIR/bin/python" \
  torch==2.14.1 torchvision==0.29.1 \
  --index-url https://download.pytorch.org/whl/cu130
# Keep installed CUDA Torch wheels; resolve other dependencies on PyPI.
uv pip install --python "$INSTALL_DIR/bin/python" \
  "audio-separator[gpu] @ git+https://github.com/HAGerox/python-audio-separator.git@$AUDIO_SEPARATOR_COMMIT" \
  torch==2.14.1 torchvision==0.29.1 \
  "onnxruntime-gpu>=1.31,<1.32" "librosa<0.11" "$SERVER_PACKAGE"

SECURITY_CHECK="$SCRIPT_DIR/check-python-security.py"
if [[ ! -f "$SECURITY_CHECK" ]]; then
  SECURITY_CHECK="$SERVER_DIR/../scripts/check-python-security.py"
fi
"$INSTALL_DIR/bin/python" "$SECURITY_CHECK"

ln -sfn "$INSTALL_DIR/bin/stem-separator-server" "$BIN_DIR/stem-separator-server"
ln -sfn "$INSTALL_DIR/bin/stem-separator-server-update" "$BIN_DIR/stem-separator-server-update"
"$INSTALL_DIR/bin/python" - <<'PY'
import onnx
import onnxruntime
import numpy as np
import torch

assert torch.cuda.is_available(), "PyTorch cannot access an NVIDIA GPU. Check the Windows NVIDIA driver and WSL GPU passthrough."
device = torch.cuda.get_device_name(0)
value = (torch.ones(4, device="cuda") * 2).sum().item()
assert value == 8
onnxruntime.preload_dlls(directory="")
providers = onnxruntime.get_available_providers()
assert "CUDAExecutionProvider" in providers, f"ONNX Runtime CUDA provider is unavailable: {providers}"
graph = onnx.helper.make_graph(
    [onnx.helper.make_node("Identity", ["x"], ["y"])], "cuda-check",
    [onnx.helper.make_tensor_value_info("x", onnx.TensorProto.FLOAT, [1])],
    [onnx.helper.make_tensor_value_info("y", onnx.TensorProto.FLOAT, [1])],
)
model = onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)])
model.ir_version = 10
session = onnxruntime.InferenceSession(model.SerializeToString(), providers=["CUDAExecutionProvider"])
assert session.get_providers()[0] == "CUDAExecutionProvider", session.get_providers()
np.testing.assert_array_equal(session.run(None, {"x": np.array([2], dtype=np.float32)})[0], [2])
print(f"Torch CUDA ready: {device} (CUDA {torch.version.cuda})")
print(f"ONNX Runtime providers: {providers}")
PY
echo "Installed. Run: stem-separator-server"
