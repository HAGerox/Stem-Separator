from __future__ import annotations

import argparse
import os
import sys

import uvicorn

from .updater import install_latest, latest_release, running_in_container


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        prog="stem-separator-server",
        description="Run the CUDA-enabled Stem Separator WebUI and API.",
    )
    value.add_argument("--host", default=os.getenv("STEM_SEPARATOR_HOST", "127.0.0.1"))
    value.add_argument("--port", type=int, default=int(os.getenv("STEM_SEPARATOR_PORT", "7860")))
    value.add_argument("--workers", type=int, default=1, help="Keep at 1: jobs share one GPU queue.")
    value.add_argument("--reload", action="store_true", help="Reload while developing the server.")
    value.add_argument("--auto-update", action="store_true", default=os.getenv("STEM_SEPARATOR_AUTO_UPDATE", "0") == "1", help="Install a newer native Linux release before starting.")
    return value


def main() -> None:
    args = parser().parse_args()
    if args.auto_update and not args.reload and not running_in_container():
        release = latest_release()
        if release["available"]:
            print(install_latest())
            os.execv(sys.executable, [sys.executable, "-m", "stem_separator_server", *sys.argv[1:]])
    uvicorn.run(
        "stem_separator_server.app:app",
        host=args.host,
        port=args.port,
        workers=args.workers,
        reload=args.reload,
    )


def update_main() -> None:
    value = argparse.ArgumentParser(prog="stem-separator-server-update")
    value.add_argument("--check", action="store_true", help="Only check for a newer GitHub release.")
    args = value.parse_args()
    release = latest_release()
    if args.check:
        print(f"Current: {release['currentVersion']}")
        print(f"Latest: {release['version'] or 'unknown'}")
        print("Update available." if release["available"] else "Already up to date.")
        return
    if running_in_container():
        raise SystemExit("Container installations update by pulling the new GHCR image and recreating the container.")
    print(install_latest())
