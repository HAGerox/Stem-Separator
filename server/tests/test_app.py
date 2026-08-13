from __future__ import annotations

import importlib
import io
import zipfile


def load_app(tmp_path, monkeypatch):
    monkeypatch.setenv("STEM_SEPARATOR_DATA_DIR", str(tmp_path))
    import stem_separator_server.app as server_app

    return importlib.reload(server_app)


def test_health_and_environment(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        payload = client.get("/api/environment").json()
        assert "cudaReady" in payload
        assert payload["dataDirectory"] == str(tmp_path)


def test_upload_rejects_unsupported_extension(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("notes.txt", b"not audio", "text/plain")},
            data={"stems": "vocals"},
        )
    assert response.status_code == 400


def test_job_processes_and_downloads_archive(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    from fastapi.testclient import TestClient

    async def fake_command(command, job):
        if command[0] == "ffmpeg":
            server_app.Path(command[-1]).write_bytes(b"RIFFextracted")
            return
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "track_(Vocals)_model.wav").write_bytes(b"RIFFvocals")
        (output_dir / "track_(Instrumental)_model.wav").write_bytes(b"RIFFinstrumental")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
            data={"stems": "vocals,instrumental"},
        )
        assert response.status_code == 202
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)
        assert job["status"] == "complete", job
        archive = client.get(job["downloadUrl"])
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert sorted(bundle.namelist()) == ["track_instrumental.wav", "track_vocals.wav"]


def test_video_audio_is_extracted_before_separation(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    from fastapi.testclient import TestClient

    commands = []

    async def fake_command(command, job):
        commands.append(command)
        if command[0] == "ffmpeg":
            server_app.Path(command[-1]).write_bytes(b"RIFFextracted")
            return
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "clip_(Vocals)_model.wav").write_bytes(b"RIFFvocals")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("clip.mp4", b"video", "video/mp4")},
            data={"stems": "vocals"},
        )
        job_id = response.json()["id"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in {"complete", "failed"}:
                break
            import time

            time.sleep(0.01)
    assert job["status"] == "complete", job
    assert commands[0][0] == "ffmpeg"
    assert commands[1][1].endswith("source-audio.wav")
