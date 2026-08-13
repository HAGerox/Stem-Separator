# Stem Separator

Local stem separation in two products:

- A macOS React + Tauri app for Apple Silicon.
- A headless Linux server for WSL2 with NVIDIA CUDA, a CLI, JSON API, and WebUI.

## What works

- Audio and video drag-and-drop, file picking, and recursive folder import
- Registry-driven vocals, instrumental, drums, bass, guitar, piano, other, and detailed kick/snare/toms/hi-hat/cymbal choices
- Automatic multi-model planning from a replaceable JSON catalog
- Local processing through the [`HAGerox/python-audio-separator`](https://github.com/HAGerox/python-audio-separator/tree/personal/pr298-pr299-combined) combined PR 298 + 299 build
- Automatic first-use engine provisioning through `uvx`
- WAV output at 44.1 kHz, written to a `Stem Separator` folder beside the source
- MP4/MOV audio extraction and optional per-stem video remuxing through FFmpeg
- Source-duration probing plus output padding/trimming before video remuxing
- Linear file/model-aware progress, expandable technical details, confirmed process cancellation, result playback, and Finder reveal
- System light/dark appearance, a draggable macOS title bar, and an extensible collapsed stem picker
- One in-app result per source/stem; video sources prefer the remuxed video while their WAV remains in Finder
- Browser-only interface demo for fast design testing

## Run the macOS app

Prerequisites:

```bash
brew install ffmpeg uv
```

Then:

```bash
npm install
npm run tauri:dev
```

The first real separation can take substantially longer because `uvx` prepares the Python 3.12 environment and the selected model files download. Later runs reuse the environment/model caches. The managed command pins commit `f0dd3f0` from `personal/pr298-pr299-combined`, which combines upstream PR 298's accelerated PyTorch paths with PR 299's MSST MDXC inference-default fixes. It also supplies `audioread` and pins `librosa<0.11` for compatibility.

On Apple Silicon macOS, the app passes `--use_torch_compile` on every separation. PR 298 enables regional `torch.compile` for verified MPS RoFormer paths and safely warns and falls back to eager inference for model/device combinations that do not support compilation. A new model or input shape can incur a one-time compilation cost before warm runs benefit.

To preview only the interface in a browser:

```bash
npm run dev
```

Open `http://localhost:1420/?demo=1` to walk through the complete sample flow without processing media.

## Run the WSL2 CUDA server

The server is designed for Ubuntu on WSL2 with an NVIDIA GPU passed through by the Windows driver. Do not install a Linux NVIDIA display driver inside WSL; verify GPU access first with:

```bash
/usr/lib/wsl/lib/nvidia-smi
```

The recommended, isolated installation is Docker. Install Docker with WSL integration and the NVIDIA Container Toolkit, then from this repository run:

```bash
docker compose -f server/compose.yaml up --build
```

Open `http://localhost:7860`. The Compose service binds only to Windows/WSL localhost, mounts persistent job and model caches, and requests all NVIDIA GPUs.

For a native WSL install instead:

```bash
sudo apt update
sudo apt install -y ffmpeg python3 python3-venv
# Install uv using the official Astral instructions, then:
./server/scripts/install-wsl.sh
stem-separator-server
```

The native server defaults to `127.0.0.1:7860`; do not bind it to another interface until authentication and TLS are added. The WebUI supports uploads, a single-GPU job queue, status polling, environment diagnostics, and ZIP downloads of 44.1 kHz WAV stems. Server state defaults to `~/.local/share/stem-separator-server`; override it with `STEM_SEPARATOR_DATA_DIR` and `STEM_SEPARATOR_MODEL_DIR`.

Useful endpoints:

- `GET /healthz`
- `GET /api/environment`
- `POST /api/jobs` as multipart form data with `file` and comma-separated `stems`
- `GET /api/jobs/{id}`
- `GET /api/jobs/{id}/download`

`STEM_SEPARATOR_TORCH_COMPILE=1` enables the fork's optional Torch compilation path. It is off by default on the server because CUDA compatibility and warm-up cost vary by model/GPU.

## Build workflows

Tagged releases (`v*`) create a GitHub Release and publish update assets:

- `Build macOS app` publishes one ad-hoc-signed (not Developer ID signed or notarized) Apple Silicon DMG. The Ed25519-signed Tauri payload and manifest live in a separate machine-readable updater release.
- `Build WSL CUDA server` publishes one Linux/WSL installer archive and `ghcr.io/hagerox/stem-separator-server:latest` plus a version tag.

Before the first tagged release, generate one Tauri updater keypair and keep it permanently:

```bash
npm run tauri signer generate -- -w stem-separator-updater.key
```

Store the private key content as the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` and its optional password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The non-secret public key is committed in `src-tauri/tauri.conf.json`. Losing or rotating the private key without a migration release prevents installed clients from trusting future updates.

Ad-hoc macOS signing can stay as-is and updates will work. It is independent of the updater signature. For normal end-user distribution, Developer ID signing and notarization are still strongly recommended because ad-hoc apps continue to trigger Gatekeeper approval and offer no Apple identity assurance.

Create a release by updating every product version (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `server/pyproject.toml`, and `server/src/stem_separator_server/__init__.py`), committing, and pushing a matching tag such as `v0.2.0`.

## Model catalog

Both products fetch `registry.json` from [`HAGerox/Stem-Separator-Models`](https://github.com/HAGerox/Stem-Separator-Models), cache the last known-good response with its ETag, and fall back to [`catalog/models.v1.json`](catalog/models.v1.json) or the server snapshot when offline.

Set `VITE_MODEL_REGISTRY_URL` for a desktop registry mirror, or `STEM_SEPARATOR_MODEL_REGISTRY_URL` for the server. The server refresh interval defaults to six hours and is configurable with `STEM_SEPARATOR_MODEL_REGISTRY_REFRESH_SECONDS`.

Recommendations are capability-aware. The global registry winner is used when `audio-separator` can execute it; otherwise its first compatible alternative is selected:

- Resurrection Vocals for vocals
- Gabox Fv7z for instrumental
- BS RoFormer SW for six-stem/instrument work
- Jarredou DrumSep 5 for kick, snare, toms, hi-hat, and cymbals
- HTDemucs FT as the compatible four-stem fallback

The registry currently recommends a MVSepLess model for strings. Because neither shipped product includes that runtime, strings were removed from the selectable stems instead of presenting the old approximate `Other` relabel. They will appear automatically once a compatible recommendation/backend is available.

## Linux/WSL updates

Native installations check GitHub and update the installed wheel with:

```bash
stem-separator-server-update --check
stem-separator-server-update
```

The updater verifies GitHub's SHA-256 digest for the single Linux release bundle; when GitHub CLI is installed it also verifies the GitHub artifact attestation before installing. Restart the service after an update. Add `--auto-update` (or `STEM_SEPARATOR_AUTO_UPDATE=1`) to update automatically before a native server starts. Docker installations update by pulling the published image and recreating the service:

```bash
docker compose -f server/compose.yaml pull
docker compose -f server/compose.yaml up -d
```

## Processing architecture

The Rust backend:

1. Expands folders and probes supported media with FFprobe.
2. Extracts a 24-bit WAV soundtrack from video sources.
3. Runs each unique catalog-selected model locally.
4. Finds the requested outputs, writes 24-bit WAV files, and pads/trims them to the probed source duration.
5. For video sources, remuxes each selected stem against the original video stream without re-encoding the picture.

Media is never uploaded by this prototype.

## Known prototype limits

- macOS remains ad-hoc signed until Developer ID credentials are configured; notarization and dependency/model-license review are still required for polished public distribution.
- Progress within one model pass is time-based because the upstream CLI does not expose a stable machine-readable percentage event stream.
- Duration alignment is implemented; a production QA suite should additionally compare decoded sample counts and channel layouts across representative codecs and variable-frame-rate video.
- The first catalog is a pragmatic starter, not a universal claim of quality. Separation quality varies by song, genre, arrangement, and whether the operator prioritizes fullness or low bleed.
- Native Windows packaging, server authentication/TLS, durable job restoration, and crash-resume are not part of this prototype.

## Verification

```bash
npm run build
cd src-tauri && cargo check
```

The interface was also exercised through select, expanded stems, progress, stop confirmation, results, and dark appearance states in the shared preview.

The original managed runtime was provisioned against `audio-separator 0.44.5`, the catalog's BS-Roformer Viperx model was downloaded, and a two-second synthetic stereo file was separated end to end with Apple Silicon MPS/CoreML available. The custom combined-PR runtime is now pinned separately as described above.
