# Stem Separator

Stem Separator turns songs into individual parts such as vocals, drums, bass,
guitar, piano, and instrumentals. Add an audio or video file, choose the stems
you want, and let the app create separate WAV files for each part.

Everything runs locally. Your media is processed on your own Mac or on a server
you control, and is never uploaded to a third-party separation service.

## Highlights

- Simple drag-and-drop workflow for audio, video, and folders
- Individual stem selection or a complete multi-track split
- Carefully selected models for different instruments
- Progress, cancellation, playback, and quick access to finished files
- Video outputs that keep the original picture with the separated audio
- Automatic model downloads and updates

The first separation may take longer while the required model is downloaded.
Later runs reuse the local model cache.

## Platforms

Stem Separator is available as:

- A desktop app for Apple Silicon Macs
- A self-hosted browser app for Linux or WSL2 systems with an NVIDIA GPU

## For developers

The desktop app uses React, TypeScript, Tauri, and a Rust processing backend.
To run it on an Apple Silicon Mac:

```bash
brew install ffmpeg uv
npm install
npm run tauri:dev
```

To preview the interface without processing media:

```bash
npm run dev
```

Then open `http://localhost:1420/?demo=1`.

To run the Linux/WSL2 server with Docker and the NVIDIA Container Toolkit:

```bash
docker compose -f server/compose.yaml up --build
```

Then open `http://localhost:7860`.

Model recommendations come from the
[Stem Separator Models](https://github.com/HAGerox/Stem-Separator-Models)
registry. Verify changes with:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## License

Stem Separator is available under the [MIT License](LICENSE). Models and other
third-party components remain subject to their own licenses.
