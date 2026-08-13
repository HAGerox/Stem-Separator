from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from packaging.version import InvalidVersion, Version

from . import __version__

RELEASE_API = "https://api.github.com/repos/HAGerox/Stem-Separator/releases/latest"
REPOSITORY = "HAGerox/Stem-Separator"
LINUX_BUNDLE_NAME = "Stem-Separator-Linux-WSL-CUDA.tar.gz"


def _request_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Stem-Separator-Server",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def latest_release() -> dict:
    release = _request_json(RELEASE_API)
    tag = release.get("tag_name", "").removeprefix("v")
    try:
        available = Version(tag) > Version(__version__)
    except InvalidVersion:
        available = False
    return {
        "available": available,
        "currentVersion": __version__,
        "version": tag or None,
        "notes": release.get("body") or "",
        "publishedAt": release.get("published_at"),
        "htmlUrl": release.get("html_url"),
        "assets": release.get("assets", []),
    }


def _download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Stem-Separator-Server"})
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)


def install_latest() -> str:
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        raise RuntimeError("The self-updater currently supports x86_64 Linux/WSL only.")
    release = latest_release()
    if not release["available"]:
        return "Stem Separator Server is already up to date."
    assets = {asset["name"]: asset for asset in release["assets"]}
    bundle_asset = assets.get(LINUX_BUNDLE_NAME)
    if not bundle_asset:
        raise RuntimeError(f"The latest release does not contain {LINUX_BUNDLE_NAME}.")
    digest = bundle_asset.get("digest", "")
    if not digest.startswith("sha256:"):
        raise RuntimeError("The Linux update bundle does not have a GitHub SHA-256 digest.")

    with tempfile.TemporaryDirectory(prefix="stem-separator-update-") as directory:
        root = Path(directory)
        bundle = root / LINUX_BUNDLE_NAME
        _download(bundle_asset["browser_download_url"], bundle)
        actual = hashlib.sha256(bundle.read_bytes()).hexdigest()
        if actual != digest.removeprefix("sha256:"):
            raise RuntimeError("The downloaded Linux update bundle failed SHA-256 verification.")
        if shutil.which("gh"):
            subprocess.run(
                ["gh", "attestation", "verify", str(bundle), "-R", REPOSITORY],
                check=True,
            )
        with tarfile.open(bundle, "r:gz") as archive:
            wheels = [member for member in archive.getmembers() if member.isfile() and member.name.endswith(".whl")]
            if len(wheels) != 1:
                raise RuntimeError("The Linux update bundle must contain exactly one server wheel.")
            source = archive.extractfile(wheels[0])
            if source is None:
                raise RuntimeError("The server wheel could not be read from the Linux update bundle.")
            wheel = root / Path(wheels[0].name).name
            with source, wheel.open("wb") as output:
                shutil.copyfileobj(source, output)
        uv = shutil.which("uv")
        command = [uv, "pip", "install", "--python", sys.executable, "--upgrade", str(wheel)] if uv else [
            sys.executable, "-m", "pip", "install", "--upgrade", str(wheel)
        ]
        subprocess.run(command, check=True)
    return f"Updated Stem Separator Server to {release['version']}. Restart the service to use it."


def running_in_container() -> bool:
    return Path("/.dockerenv").exists() or os.getenv("container") is not None
