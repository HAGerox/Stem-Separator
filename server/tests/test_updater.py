from __future__ import annotations

import hashlib
import io
import tarfile

from stem_separator_server import updater


def linux_bundle() -> bytes:
    output = io.BytesIO()
    wheel = b"test wheel"
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        member = tarfile.TarInfo("./stem_separator_server-9.9.9-py3-none-any.whl")
        member.size = len(wheel)
        archive.addfile(member, io.BytesIO(wheel))
    return output.getvalue()


def test_install_latest_from_single_linux_bundle(monkeypatch):
    bundle = linux_bundle()
    asset = {
        "name": updater.LINUX_BUNDLE_NAME,
        "browser_download_url": "https://example.invalid/linux.tar.gz",
        "digest": f"sha256:{hashlib.sha256(bundle).hexdigest()}",
    }
    monkeypatch.setattr(updater.platform, "system", lambda: "Linux")
    monkeypatch.setattr(updater.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(
        updater,
        "latest_release",
        lambda: {"available": True, "version": "9.9.9", "assets": [asset]},
    )
    monkeypatch.setattr(updater, "_download", lambda _url, target: target.write_bytes(bundle))
    monkeypatch.setattr(updater.shutil, "which", lambda command: "/usr/bin/uv" if command == "uv" else None)
    commands = []
    monkeypatch.setattr(updater.subprocess, "run", lambda command, check: commands.append(command))

    result = updater.install_latest()

    assert result.startswith("Updated Stem Separator Server to 9.9.9")
    assert commands[0][:5] == ["/usr/bin/uv", "pip", "install", "--python", updater.sys.executable]
    assert commands[0][-1].endswith("stem_separator_server-9.9.9-py3-none-any.whl")


def test_install_latest_rejects_digest_mismatch(monkeypatch):
    bundle = linux_bundle()
    monkeypatch.setattr(updater.platform, "system", lambda: "Linux")
    monkeypatch.setattr(updater.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(
        updater,
        "latest_release",
        lambda: {
            "available": True,
            "version": "9.9.9",
            "assets": [{
                "name": updater.LINUX_BUNDLE_NAME,
                "browser_download_url": "https://example.invalid/linux.tar.gz",
                "digest": "sha256:" + "0" * 64,
            }],
        },
    )
    monkeypatch.setattr(updater, "_download", lambda _url, target: target.write_bytes(bundle))

    try:
        updater.install_latest()
    except RuntimeError as error:
        assert "failed SHA-256 verification" in str(error)
    else:
        raise AssertionError("Digest mismatch should reject the update bundle")
