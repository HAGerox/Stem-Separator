# Stem Separator Server

The headless Linux/WSL2 product. It provides a CLI, JSON API, and browser WebUI backed by the pinned HAGerox `python-audio-separator` fork.

Quick start from the repository root:

```bash
docker compose -f server/compose.yaml up --build
```

Then open `http://localhost:7860`. See the repository root README for native WSL installation, CUDA checks, endpoints, environment variables, and workflow artifacts.
