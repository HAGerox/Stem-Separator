from __future__ import annotations

import importlib
import io
import zipfile


def load_app(tmp_path, monkeypatch):
    monkeypatch.setenv("STEM_SEPARATOR_DATA_DIR", str(tmp_path))
    import stem_separator_server.app as server_app

    return importlib.reload(server_app)


def freeze_registry(server_app, monkeypatch):
    monkeypatch.setattr(server_app.REGISTRY, "refresh", lambda force=False: False)


def test_health_and_environment(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        payload = client.get("/api/environment").json()
        assert "cudaReady" in payload
        assert payload["dataDirectory"] == str(tmp_path)
        page = client.get("/")
        assert page.status_code == 200
        assert '<div id="root"></div>' in page.text
        assert "CUDA Server" not in page.text


def test_upload_rejects_unsupported_extension(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
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
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def fake_command(command, job, progress_range=None, **kwargs):
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
        output = client.get(job["outputs"][0]["url"])
        assert output.status_code == 200


def test_video_audio_is_extracted_before_separation(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    commands = []

    async def fake_command(command, job, progress_range=None, **kwargs):
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
    assert "0:a:0?" in commands[0]
    assert commands[1][1].endswith("source-audio.wav")


def test_model_registry_exposes_only_compatible_stems(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    with TestClient(server_app.app) as client:
        payload = client.get("/api/models").json()
    assert "strings" not in payload["stems"]
    assert {"vocals", "instrumental", "kick", "cymbals"}.issubset(payload["stems"])


def test_registry_builds_capability_aware_plan(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    plan = server_app.REGISTRY.plan(["vocals", "instrumental"])
    assert [model.filename for model in plan] == [
        "bs_roformer_vocals_resurrection_unwa.ckpt",
        "mel_band_roformer_instrumental_fv7z_gabox.ckpt",
    ]
    payload = server_app.REGISTRY.payload()
    assert payload["catalog"]["schemaVersion"] == 1
    assert payload["catalog"]["recommendations"]["vocals"] == "resurrection-vocals"


def test_multitrack_is_an_explicit_special_case(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    selected = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    individual = server_app.REGISTRY.plan(selected, multi_track=False)
    multitrack = server_app.REGISTRY.plan(selected, multi_track=True)
    assert len(multitrack) == 1
    assert multitrack[0].filename == "BS-Roformer-SW.ckpt"
    assert len(individual) > 1


def test_multiple_files_are_accepted_and_return_named_outputs(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def fake_command(command, job, progress_range=None, **kwargs):
        output_dir = server_app.Path(command[command.index("--output_dir") + 1])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "track_(Vocals)_model.wav").write_bytes(b"RIFFvocals")

    monkeypatch.setattr(server_app, "run_command", fake_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files=[
                ("files", ("first.wav", b"RIFFone", "audio/wav")),
                ("files", ("second.wav", b"RIFFtwo", "audio/wav")),
            ],
            data={"stems": "vocals"},
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
    assert job["file_count"] == 2
    assert {output["sourceName"] for output in job["outputs"]} == {"first.wav", "second.wav"}


def test_job_can_be_cancelled(tmp_path, monkeypatch):
    server_app = load_app(tmp_path, monkeypatch)
    freeze_registry(server_app, monkeypatch)
    from fastapi.testclient import TestClient

    async def slow_command(command, job, progress_range=None, **kwargs):
        await server_app.asyncio.sleep(0.2)

    monkeypatch.setattr(server_app, "run_command", slow_command)
    with TestClient(server_app.app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("track.wav", b"RIFFinput", "audio/wav")},
            data={"stems": "vocals"},
        )
        job_id = response.json()["id"]
        cancelled = client.delete(f"/api/jobs/{job_id}")
        assert cancelled.status_code == 202
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] == "cancelled":
                break
            import time

            time.sleep(0.01)
    assert job["status"] == "cancelled"
