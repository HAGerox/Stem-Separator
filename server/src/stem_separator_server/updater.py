from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from packaging.version import InvalidVersion, Version

from . import __version__

RELEASE_API = "https://api.github.com/repos/HAGerox/Stem-Separator/releases/latest"
REPOSITORY = "HAGerox/Stem-Separator"


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
    wheel_name = next((name for name in assets if name.endswith("-py3-none-any.whl")), None)
    checksum_asset = assets.get("SHA256SUMS")
    if not wheel_name or not checksum_asset:
        raise RuntimeError("The latest release does not contain the server wheel and SHA256SUMS.")

    with tempfile.TemporaryDirectory(prefix="stem-separator-update-") as directory:
        root = Path(directory)
        wheel = root / wheel_name
        sums = root / "SHA256SUMS"
        _download(assets[wheel_name]["browser_download_url"], wheel)
        _download(checksum_asset["browser_download_url"], sums)
        expected = None
        for line in sums.read_text().splitlines():
            digest, _, filename = line.partition("  ")
            if filename == wheel_name:
                expected = digest.strip()
                break
        actual = hashlib.sha256(wheel.read_bytes()).hexdigest()
        if not expected or actual != expected:
            raise RuntimeError("The downloaded server wheel failed SHA-256 verification.")
        if shutil.which("gh"):
            subprocess.run(
                ["gh", "attestation", "verify", str(wheel), "-R", REPOSITORY],
                check=True,
            )
        uv = shutil.which("uv")
        command = [uv, "pip", "install", "--python", sys.executable, "--upgrade", str(wheel)] if uv else [
            sys.executable, "-m", "pip", "install", "--upgrade", str(wheel)
        ]
        subprocess.run(command, check=True)
    return f"Updated Stem Separator Server to {release['version']}. Restart the service to use it."


def running_in_container() -> bool:
    return Path("/.dockerenv").exists() or os.getenv("container") is not None
