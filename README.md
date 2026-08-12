# Stem Separator

A macOS-first React + Tauri prototype for effortless local audio stem separation. Drop files or a folder, choose the parts you want, and the app selects a compact set of compatible models automatically.

## What works

- Audio and video drag-and-drop, file picking, and recursive folder import
- Vocals, instrumental, drums, bass, guitar, piano, strings, and other stem choices
- Automatic multi-model planning from a replaceable JSON catalog
- Local processing through [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator)
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

The first real separation can take substantially longer because `uvx` prepares the Python 3.12 environment and the selected model files download. Later runs reuse the environment/model caches. The managed command currently pins the tested `audio-separator 0.44.5`, supplies `audioread`, and pins `librosa<0.11`; the upstream CPU package omits the former and still calls an API removed in librosa 0.11.

To preview only the interface in a browser:

```bash
npm run dev
```

Open `http://localhost:1420/?demo=1` to walk through the complete sample flow without processing media.

## Model catalog

The bundled catalog lives at [`catalog/models.v1.json`](catalog/models.v1.json) and its validation shape is documented by [`catalog/schema.v1.json`](catalog/schema.v1.json). The UI contains no hard-coded model routing.

Set `VITE_MODEL_CATALOG_URL` at build time to fetch a hosted catalog. The app validates the schema version, uses `cache: no-cache`, and falls back to the bundled catalog when offline or when the hosted data is invalid.

The current local routes are deliberately conservative:

- BS-Roformer Viperx 1297 for vocals/instrumental
- HTDemucs FT for four-stem work
- HTDemucs 6s for guitar/piano and broad six-stem work
- Strings currently use the broad `Other` output and are explicitly marked approximate in the completed job

MVSep exposes more specialized capabilities, including strings and individual instrument models, but its algorithm names cannot simply be passed to the local `audio-separator` runtime. Those entries should remain `remote` or `research-only` until a real compatible provider exists.

## Processing architecture

The Rust backend:

1. Expands folders and probes supported media with FFprobe.
2. Extracts a 24-bit WAV soundtrack from video sources.
3. Runs each unique catalog-selected model locally.
4. Finds the requested outputs, writes 24-bit WAV files, and pads/trims them to the probed source duration.
5. For video sources, remuxes each selected stem against the original video stream without re-encoding the picture.

Media is never uploaded by this prototype.

## Known prototype limits

- A full production release should bundle or install FFmpeg and the Python runtime through a signed onboarding flow rather than relying on Homebrew.
- Progress within one model pass is time-based because the upstream CLI does not expose a stable machine-readable percentage event stream.
- Duration alignment is implemented; a production QA suite should additionally compare decoded sample counts and channel layouts across representative codecs and variable-frame-rate video.
- The first catalog is a pragmatic starter, not a universal claim of quality. Separation quality varies by song, genre, arrangement, and whether the operator prioritizes fullness or low bleed.
- App signing, notarization, automatic updates, Windows packaging, and crash-resume are not part of this first prototype.

## Verification

```bash
npm run build
cd src-tauri && cargo check
```

The interface was also exercised through select, expanded stems, progress, stop confirmation, results, and dark appearance states in the shared preview.

The managed runtime was provisioned against `audio-separator 0.44.5`, the catalog's BS-Roformer Viperx model was downloaded, and a two-second synthetic stereo file was separated end to end with Apple Silicon MPS/CoreML available. The resulting WAV probed as stereo PCM at 44.1 kHz with the exact two-second source duration.
