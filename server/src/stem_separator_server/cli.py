from __future__ import annotations

import argparse
import os

import uvicorn


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        prog="stem-separator-server",
        description="Run the CUDA-enabled Stem Separator WebUI and API.",
    )
    value.add_argument("--host", default=os.getenv("STEM_SEPARATOR_HOST", "127.0.0.1"))
    value.add_argument("--port", type=int, default=int(os.getenv("STEM_SEPARATOR_PORT", "7860")))
    value.add_argument("--workers", type=int, default=1, help="Keep at 1: jobs share one GPU queue.")
    value.add_argument("--reload", action="store_true", help="Reload while developing the server.")
    return value


def main() -> None:
    args = parser().parse_args()
    uvicorn.run(
        "stem_separator_server.app:app",
        host=args.host,
        port=args.port,
        workers=args.workers,
        reload=args.reload,
    )

